// server.js - Backend API for Jeff with Google Gemini
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');
const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
const NodeCache = require('node-cache');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy - needed for correct IP detection behind reverse proxies
app.set('trust proxy', 1);

// Security Middleware
app.use(helmet()); // Adds security headers

// CORS configuration - allow all origins in development, restrict in production
const corsOptions = {
  origin: true, // Allow all origins
  credentials: true,
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));

// Body parsing with size limits
app.use(express.json({ limit: '100kb' })); // Limit request body to 100kb (for conversation history)
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

// Sanitize data against NoSQL injection
app.use(mongoSanitize());

// Error handler for payload too large
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'Conversation too long',
      message: 'Your conversation history has gotten too long! 😅 Please refresh the page and start a new conversation with me. Don\'t worry, I\'ll still remember how to help you!',
      link: null
    });
  }
  next(err);
});

// Initialize Gemini AI (for research agent)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Initialize OpenAI (for analysis and personality agent)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || 'your_openai_api_key_here'
});

// Initialize response cache
// TTL: 24 hours (86400 seconds), check period: 1 hour (3600 seconds)
const responseCache = new NodeCache({
  stdTTL: 86400,  // Cache responses for 24 hours
  checkperiod: 3600,  // Check for expired keys every hour
  useClones: false  // Don't clone objects for better performance
});

// Cache statistics
let cacheStats = {
  hits: 0,
  misses: 0,
  saves: 0
};

// Rate limiting using express-rate-limit (more secure, prevents IP spoofing)
const chatLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20, // 20 requests per minute
  message: {
    error: 'Rate limit exceeded',
    message: 'Whoa there! You\'re asking questions too fast! 😅 Give me a moment to catch my breath. Try again in a minute!',
    link: null
  },
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false // Disable the `X-RateLimit-*` headers
  // Use default key generator which properly handles IPv6
});

// Input sanitization function
function sanitizeInput(input) {
  if (typeof input !== 'string') return '';

  // Remove potential prompt injection attempts
  const cleaned = input
    .replace(/[<>]/g, '') // Remove angle brackets
    .replace(/javascript:/gi, '') // Remove javascript: protocol
    .replace(/on\w+\s*=/gi, '') // Remove event handlers
    .trim()
    .substring(0, 1000); // Max 1000 chars

  return cleaned;
}

// Validate conversation history
function validateConversationHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .slice(-10) // Only keep last 10 messages
    .filter(msg => {
      return msg &&
             typeof msg === 'object' &&
             typeof msg.role === 'string' &&
             typeof msg.content === 'string' &&
             (msg.role === 'user' || msg.role === 'assistant');
    })
    .map(msg => ({
      role: msg.role,
      content: sanitizeInput(msg.content)
    }));
}

// Generate cache key from message and conversation history
function generateCacheKey(message, conversationHistory) {
  // Create a string combining the message and recent conversation context
  const contextString = conversationHistory
    .slice(-3) // Only use last 3 messages for context
    .map(msg => `${msg.role}:${msg.content}`)
    .join('|');

  const fullContext = `${contextString}|user:${message}`;

  // Generate SHA256 hash as cache key
  return crypto.createHash('sha256').update(fullContext).digest('hex');
}

// Web fetching function that Gemini can call
async function fetchWebPage(url) {
  try {
    const response = await axios.get(url, {
      timeout: 5000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; JeffBot/1.0;)'
      }
    });

    const $ = cheerio.load(response.data);

    // Remove script and style elements
    $('script, style, nav, header, footer').remove();

    // Extract text content
    const textContent = $('body').text()
      .replace(/\s+/g, ' ') // Replace multiple spaces with single space
      .trim()
      .substring(0, 5000); // Limit to 5000 chars

    return {
      success: true,
      content: textContent,
      url: url
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      url: url
    };
  }
}

// Define the function declaration for Gemini
const fetchWebPageDeclaration = {
  name: "fetchWebPage",
  description: "Fetches and extracts text content from a web page. Use this when you need specific, current information about universities, programs, residences, or other details that you don't have in your knowledge base. For example, if asked about specific residence hall types (traditional vs suite style), program details, admission requirements, or other university-specific facts.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The full URL to fetch. Must be a complete URL starting with http:// or https://. Use NaviGrad URLs from the knowledge base or university official websites."
      }
    },
    required: ["url"]
  }
};

// NaviGrad Database
const navigradData = {
  universities: {
    brock: { name: 'Brock University', url: 'https://sites.google.com/view/navigrad/major-universities/brock-university?authuser=0', location: 'St. Catharines' },
    western: { name: 'Western University', url: 'https://sites.google.com/view/navigrad/major-universities/western-university?authuser=0', location: 'London' },
    waterloo: { name: 'University of Waterloo', url: 'https://sites.google.com/view/navigrad/major-universities/university-of-waterloo?authuser=0', location: 'Waterloo' },
    toronto: { name: 'University of Toronto', url: 'https://sites.google.com/view/navigrad/major-universities/university-of-toronto/uoft-st-george?authuser=0', location: 'Toronto' },
    mcmaster: { name: 'McMaster University', url: 'https://sites.google.com/view/navigrad/major-universities/mcmaster-university?authuser=0', location: 'Hamilton' },
    queens: { name: 'Queen\'s University', url: 'https://sites.google.com/view/navigrad/major-universities/queens-university?authuser=0', location: 'Kingston' },
    ottawa: { name: 'University of Ottawa', url: 'https://sites.google.com/view/navigrad/major-universities/university-of-ottawa?authuser=0', location: 'Ottawa' },
    guelph: { name: 'University of Guelph', url: 'https://sites.google.com/view/navigrad/major-universities/univeristy-of-guelph?authuser=0', location: 'Guelph' },
    ryerson: { name: 'Toronto Metropolitan University', url: 'https://sites.google.com/view/navigrad/major-universities/toronto-metropolitan-university?authuser=0', location: 'Toronto' },
    york: { name: 'York University', url: 'https://sites.google.com/view/navigrad/major-universities/york-university?authuser=0', location: 'Toronto' },
    carleton: { name: 'Carleton University', url: 'https://sites.google.com/view/navigrad/major-universities/carleton-university?authuser=0', location: 'Ottawa' },
    laurier: { name: 'Wilfrid Laurier University', url: 'https://sites.google.com/view/navigrad/major-universities/laurier-university?authuser=0', location: 'Waterloo' },
    ocad: { name: 'OCAD University', url: 'https://www.navigrad.ca/major-universities/ocad', location: 'Toronto' }
  },
  colleges: {
    niagara: { name: 'Niagara College', url: 'https://www.navigrad.ca/major-colleges/niagara', location: 'Niagara Region' },
    centennial: { name: 'Centennial College', url: 'https://www.navigrad.ca/major-colleges/centennial', location: 'Toronto' },
    seneca: { name: 'Seneca College', url: 'https://www.navigrad.ca/major-colleges/seneca', location: 'Toronto' },
    algonquin: { name: 'Algonquin College', url: 'https://www.navigrad.ca/major-colleges/algonquin', location: 'Ottawa' },
    georgeBrown: { name: 'George Brown College', url: 'https://www.navigrad.ca/major-colleges/george-brown', location: 'Toronto' },
    fanshawe: { name: 'Fanshawe College', url: 'https://www.navigrad.ca/major-colleges/fanshawe', location: 'London' },
    mohawk: { name: 'Mohawk College', url: 'https://www.navigrad.ca/major-colleges/mohawk', location: 'Hamilton' },
    loyalist: { name: 'Loyalist College', url: 'https://www.navigrad.ca/major-colleges/loyalist', location: 'Belleville' },
    conestoga: { name: 'Conestoga College', url: 'https://www.navigrad.ca/major-colleges/conestoga', location: 'Kitchener-Waterloo' },
    cambrian: { name: 'Cambrian College', url: 'https://www.navigrad.ca/major-colleges/cambrian', location: 'Sudbury' }
  },
  features: {
    quiz: { name: 'Program Selector Quiz', url: 'https://www.navigrad.ca/quiz', description: 'Interactive quiz to find your ideal program, discover matching majors, identify suitable fields of study, get personalized program recommendations, explore academic paths based on interests, aptitudes, career goals, and preferences. Take the quiz to find programs that fit your strengths and passions.' },
    colleges: { name: 'College Information', url: 'https://www.navigrad.ca/colleges', description: 'Comprehensive guide to Ontario colleges, college system overview, list of colleges, program offerings, applied learning, hands-on training, diploma programs, certificate courses, college vs university, technical education, vocational training, skilled trades, and everything you need to know about Ontario college education.' },
    apprenticeship: { name: 'Apprenticeship Programs', url: 'https://www.navigrad.ca/apprenticeship', description: 'Complete guide to apprenticeships in Ontario, skilled trades training, earn while you learn, hands-on learning, trade certifications, journeyperson certification, trade schools, on-the-job training, apprenticeship opportunities, construction trades, electrical, plumbing, automotive, and alternative pathways to traditional university.' },
    shop: { name: 'University Essentials Shop', url: 'https://www.navigrad.ca/shop', description: 'NaviGrad marketplace for university essentials, student supplies, dorm room items, academic materials, study tools, textbooks, school gear, student discounts, recommended products, curated university items, everything you need for university life, and convenient shopping for students.' },
    home: { name: 'Home Page', url: 'https://www.navigrad.ca/', description: 'NaviGrad main page, platform overview, start exploring, discover resources, access all tools, browse universities, find programs, career exploration, student resources hub, central navigation, and your gateway to all NaviGrad features and Ontario post-secondary information.' }
  },
  careers: {
    'Software Engineer': { programs: ['Computer Science', 'Software Engineering'], universities: ['waterloo', 'toronto', 'mcmaster'], salary: '$80k-120k' },
    'Nurse': { programs: ['Nursing', 'Health Sciences'], universities: ['mcmaster', 'ryerson', 'western'], salary: '$70k-90k' },
    'Teacher': { programs: ['Education', 'Teaching'], universities: ['western', 'queens', 'york'], salary: '$60k-90k' },
    'Business Professional': { programs: ['Business', 'Commerce', 'Finance'], universities: ['western', 'york', 'ryerson'], salary: '$60k-150k+' },
    'Engineer': { programs: ['Engineering'], universities: ['waterloo', 'toronto', 'mcmaster'], salary: '$70k-110k' },
    'Doctor': { programs: ['Health Sciences', 'Life Sciences'], universities: ['mcmaster', 'toronto', 'western'], salary: '$200k+' },
    'Lawyer': { programs: ['Law', 'Political Science'], universities: ['toronto', 'western', 'queens'], salary: '$80k-150k+' },
    'Psychologist': { programs: ['Psychology'], universities: ['western', 'toronto', 'york'], salary: '$75k-95k' },
    'Data Scientist': { programs: ['Data Science', 'Statistics', 'Computer Science'], universities: ['waterloo', 'toronto', 'mcmaster'], salary: '$85k-130k' }
  },
  tools: {
    careerFinder: { name: 'Career Finder', url: 'https://www.navigrad.ca/career-finder', type: 'INTERNAL', description: 'NaviGrad\'s interactive career discovery tool to match your interests, skills, passions, strengths, and personality to ideal careers. Find job options, career paths, profession ideas, and occupation suggestions based on what you enjoy doing.' },
    startPage: { name: 'Start Page', url: 'https://www.navigrad.ca/start', type: 'GUIDE', description: 'Complete guide to begin your post-secondary journey in Ontario. Learn about the application process, OUAC, choosing programs, visiting campuses, finding your path, getting started with university or college planning, and first steps for grade 11-12 students.' },
    myBlueprint: { name: 'MyBlueprint', url: 'https://www.navigrad.ca/myblueprint', type: 'EXTERNAL_LINK', description: 'EXTERNAL TOOL (not created by NaviGrad) - Comprehensive career and education planning platform. NaviGrad provides information and links to this external resource where students can create portfolios, explore pathways, plan courses, set goals, and track progress.' },
    aiChatbots: { name: 'Best AI Chatbots', url: 'https://www.navigrad.ca/best-ai-chatbots', type: 'EXTERNAL_LINK', description: 'EXTERNAL RESOURCES (not created by NaviGrad) - Curated list and information about AI tools like ChatGPT, educational AI assistants, and study tools. NaviGrad provides guidance on which external AI resources are helpful for studying, homework, research, and learning.' }
  },
  interactiveGames: {
    careerPathExplorer: { name: 'Career Path Explorer', url: 'https://sites.google.com/view/navigrad/career-path-explorer', type: 'GAME', description: '🎮 INTERACTIVE GAME created by NaviGrad! Explore different career pathways through an engaging, interactive experience. Navigate various professional routes, understand job advancement, discover industry transitions, and learn how to journey from education to employment in different fields through gamified exploration.' },
    newUniversityDefense: { name: 'New University Defense', url: 'https://sites.google.com/view/navigrad/new-university-defense', type: 'GAME', description: '🎮 INTERACTIVE GAME created by NaviGrad! Fun, gamified way to learn survival strategies for your first year of university. Practice handling challenges, managing stress, balancing academics, dealing with social pressures, and developing independence skills through interactive gameplay.' },
    futureSkillsArena: { name: 'Future Skills Arena', url: 'https://sites.google.com/view/navigrad/future-skills-arena', type: 'GAME', description: '🎮 INTERACTIVE GAME created by NaviGrad! Battle through an arena-style game while learning in-demand skills for the future job market. Discover emerging careers, technology trends, workplace competencies, and what employers look for - all through engaging, interactive gameplay.' },
    dayPlannerChallenge: { name: 'Day Planner Challenge', url: 'https://sites.google.com/view/navigrad/day-planner-challenge', type: 'GAME', description: '🎮 INTERACTIVE GAME created by NaviGrad! Master time management through an interactive planning challenge. Practice scheduling classes, study time, extracurriculars, social activities, and self-care. Build essential university time management skills in a fun, gamified way.' }
  },
  studentResources: {
    scholarships: { name: 'Scholarships', url: 'https://www.navigrad.ca/scholarships', description: 'Comprehensive database of scholarships, bursaries, grants, awards, financial aid, funding opportunities, money for school, free money for students, merit-based awards, need-based assistance, entrance scholarships, and ways to pay for university or college without student loans.' },
    studentLoans: { name: 'Student Loans', url: 'https://www.navigrad.ca/student-loans', description: 'Complete guide to OSAP (Ontario Student Assistance Program), student loans, government funding, financial aid applications, loan repayment, interest rates, borrowing money for school, student debt management, provincial aid, federal loans, and financing your education in Ontario.' },
    spc: { name: 'SPC Card', url: 'https://www.navigrad.ca/spc', description: 'Student Price Card (SPC) benefits, discounts, deals, savings, student perks, promotional offers, merchant partners, how to save money as a student, student discount programs, retail savings, food discounts, and ways to stretch your student budget.' },
    extracurriculars: { name: 'Extracurriculars', url: 'https://www.navigrad.ca/extracurriculars', description: 'Clubs, sports, teams, activities, volunteering, community service, leadership opportunities, student organizations, hobbies, competitions, events, and extracurricular involvement to enhance your university application, build your resume, develop skills, and stand out to admissions.' }
  },
  preparationGuides: {
    gettingReady: { name: 'Getting Ready for University', url: 'https://www.navigrad.ca/getting-ready-for-university', description: 'Essential preparation tips, checklists, advice, and guides for transitioning from high school to university. Learn what to expect, how to prepare mentally and academically, first-year readiness, moving away from home, residence prep, course selection, orientation planning, and everything you need before starting university.' },
    universityEssentials: { name: 'University Essentials', url: 'https://www.navigrad.ca/university-essentials', description: 'Must-have items, required supplies, necessary gear, essential equipment, mandatory purchases, basic needs, school supplies, dorm room necessities, technology requirements, textbooks, laptops, stationery, and everything you absolutely need for successful university life and academics.' },
    universityExtras: { name: 'University Extras', url: 'https://www.navigrad.ca/university-extras', description: 'Nice-to-have items, optional purchases, recommended extras, comfort items, quality of life improvements, dorm decorations, study enhancements, leisure items, convenience products, and things that enhance your university experience beyond the basics.' },
    skillsToKnow: { name: 'Skills To Know', url: 'https://www.navigrad.ca/skills-to-know', description: 'Essential life skills, study techniques, time management, organization, critical thinking, communication abilities, research skills, note-taking strategies, exam preparation, productivity methods, and fundamental competencies every university student should develop for academic and personal success.' },
    interviewSkills: { name: 'Interview Skills', url: 'https://www.navigrad.ca/skills-to-know/interview-skills', description: 'Master interview techniques, preparation strategies, answering questions, behavioral interviews, STAR method, confident communication, body language, dress code, follow-up etiquette, common questions, how to prepare, tips to ace university admission interviews, scholarship interviews, and job interviews.' },
    importantSkills: { name: 'Important Skills', url: 'https://www.navigrad.ca/important-skills', description: 'Key competencies, vital abilities, crucial skills, professional development, workplace readiness, transferable skills, soft skills, hard skills, employability factors, career success skills, leadership, teamwork, problem-solving, and competencies for academic achievement and future career advancement.' },
    laptops: { name: 'Laptops for University', url: 'https://www.navigrad.ca/getting-ready-for-university/university-essentials/laptops', description: 'ESSENTIAL - Best laptops for students, computer recommendations, MacBook vs Windows, budget laptops, performance specs, battery life, portability, student discounts, tech requirements by program, and choosing the right laptop for university needs.' },
    scientificCalculators: { name: 'Scientific Calculators', url: 'https://www.navigrad.ca/getting-ready-for-university/university-essentials/scientific-calculators', description: 'ESSENTIAL for math/science/engineering - Required calculators, approved models for exams, graphing calculators, TI-84, Casio models, calculator features, what to buy for different programs, and essential calculation tools for university courses.' },
    desktopsPeripherals: { name: 'Desktops & Peripherals', url: 'https://www.navigrad.ca/getting-ready-for-university/university-extras/desktops-and-peripherals', description: 'EXTRAS - Desktop computers, monitors, keyboards, mice, webcams, microphones, gaming setups, dual monitor setups, ergonomic equipment, tech accessories, and optional computer equipment that enhances your university workspace.' },
    learningHowToLearn: { name: 'Learning How to Learn', url: 'https://www.navigrad.ca/getting-ready-for-university/learning-how-to-learn', description: 'META-LEARNING - Study strategies, learning techniques, memory improvement, effective note-taking, active recall, spaced repetition, how to study efficiently, maximizing retention, understanding learning science, and becoming a better learner.' },
    learningToCode: { name: 'Learning to Code', url: 'https://www.navigrad.ca/important-skills/learning-to-code', description: 'Programming fundamentals, coding languages to learn (Python, Java, JavaScript), online coding resources, practice platforms, building projects, software development basics, preparing for CS programs, and essential coding skills for the future job market.' },
    gettingBetterAtSpeaking: { name: 'Getting Better at Speaking', url: 'https://www.navigrad.ca/important-skills/getting-better-at-speaking', description: 'Public speaking skills, presentation techniques, confidence building, articulation, voice projection, overcoming anxiety, communication skills, delivering speeches, class presentations, and improving verbal communication abilities.' },
    networkingSkills: { name: 'Networking Skills', url: 'https://www.navigrad.ca/important-skills/networking', description: 'Professional networking, building connections, LinkedIn strategies, networking events, informational interviews, maintaining relationships, networking for careers, making meaningful connections, and growing your professional network.' },
    timeManagementSkills: { name: 'Time Management', url: 'https://www.navigrad.ca/important-skills/time-management', description: 'Managing your schedule, prioritization, productivity techniques, avoiding procrastination, balancing academics and social life, study schedules, time blocking, calendar management, and mastering time management for university success.' },
    unleashingPotential: { name: 'Unleashing Your Potential', url: 'https://www.navigrad.ca/important-skills/unleashing-your-potential', description: 'Personal development, growth mindset, maximizing abilities, discovering strengths, setting ambitious goals, overcoming limitations, self-improvement, reaching your full potential, and becoming the best version of yourself.' }
  },
  earningMoney: {
    sideHustles: { name: 'Side Hustles', url: 'https://www.navigrad.ca/making-money/side-hustles', description: 'Ways to earn extra money, make cash while studying, freelancing opportunities, gig economy jobs, passive income ideas, online money-making, entrepreneurship for students, part-time business ideas, flexible income sources, and creative ways to fund your education while maintaining academic success.' },
    employment: { name: 'Employment', url: 'https://www.navigrad.ca/making-money/employment', description: 'Part-time jobs, full-time work, student employment opportunities, on-campus jobs, off-campus positions, work-study programs, summer jobs, career opportunities, job search strategies, resume building, where to find work, hiring resources, and employment options for students.' },
    coopInternships: { name: 'Co-op & Internships', url: 'https://www.navigrad.ca/making-money/co-opinternships', description: 'Gain valuable work experience, paid internships, co-op programs, work-integrated learning, industry placements, hands-on training, professional development, networking opportunities, career exploration, employer connections, and programs that combine academic study with real-world workplace experience.' }
  },
  programs: {
    universityPrograms: { name: 'University Programs', url: 'https://www.navigrad.ca/university-programs', description: 'Browse and explore university programs, majors, degrees, fields of study, academic disciplines, bachelor programs, undergraduate options, subject areas, faculties, departments, specialized streams, honors programs, combined degrees, program requirements, and detailed information about what you can study at Ontario universities.' },
    collegePrograms: { name: 'College Programs', url: 'https://www.navigrad.ca/college-programs', description: 'Explore Ontario college diploma programs, certificate courses, advanced diplomas, vocational training, technical education, skilled trades, applied learning, hands-on programs, career-focused education, two-year programs, three-year programs, college majors, and practical training options at Ontario colleges.' },
    universityXCollege: { name: 'University X College Programs', url: 'https://www.navigrad.ca/university-x-college-programs', description: 'Combined university-college pathways, transfer programs, articulation agreements, 2+2 programs, college-to-university transfers, dual credentials, collaborative programs, pathway opportunities, bridging programs, and options to combine college diplomas with university degrees for comprehensive education.' }
  },
  specificPrograms: {
    kinesiology: { name: 'Kinesiology Programs', url: 'https://www.navigrad.ca/university-programs/kinesiology', description: 'Study of human movement, exercise science, biomechanics, anatomy, physiology, motor control, sports medicine, athletic training, fitness, and movement sciences. Great for careers in physiotherapy, chiropractics, sports, fitness, and health.' },
    healthSciences: { name: 'Health Sciences Programs', url: 'https://www.navigrad.ca/university-programs/health-sciences', description: 'Broad health field study, healthcare systems, public health, epidemiology, health policy, medical research, and foundation for medical school, nursing, dentistry, pharmacy, and other health professions.' },
    nursing: { name: 'Nursing Programs', url: 'https://www.navigrad.ca/university-programs/nursing', description: 'Become a Registered Nurse (RN), patient care, clinical practice, medical knowledge, healthcare delivery, hospital training, nursing theory, and direct patient healthcare career.' },
    business: { name: 'Business Programs', url: 'https://www.navigrad.ca/university-programs/business', description: 'Business administration, management, finance, marketing, accounting, entrepreneurship, operations, strategy, and preparation for careers in business world.' },
    engineering: { name: 'Engineering Programs', url: 'https://www.navigrad.ca/university-programs/engineering', description: 'All engineering disciplines, problem-solving, design, mathematics, sciences, technical skills, and building solutions for real-world challenges across multiple engineering fields.' },
    arts: { name: 'Arts Programs', url: 'https://www.navigrad.ca/university-programs/arts', description: 'Liberal arts, humanities, social sciences, languages, literature, history, philosophy, psychology, sociology, political science, and broad education in human culture and society.' },
    sciences: { name: 'Science Programs', url: 'https://www.navigrad.ca/university-programs/sciences', description: 'Natural sciences, physical sciences, biological sciences, chemistry, physics, research, lab work, scientific method, and foundation for science careers or professional schools.' },
    mathematics: { name: 'Mathematics Programs', url: 'https://www.navigrad.ca/university-programs/mathematics', description: 'Pure mathematics, applied mathematics, statistics, actuarial science, mathematical modeling, problem-solving, logic, and quantitative reasoning for tech, finance, research careers.' },
    socialSciences: { name: 'Social Sciences Programs', url: 'https://www.navigrad.ca/university-programs/social-sciences', description: 'Study of human society, psychology, sociology, anthropology, economics, political science, human behavior, social structures, and understanding how society works.' },
    criminology: { name: 'Criminology Programs', url: 'https://www.navigrad.ca/university-programs/criminology', description: 'Criminal justice, law enforcement, crime analysis, criminal behavior, justice system, policing, corrections, forensics, and careers in law enforcement or criminal justice.' },
    medicalSciences: { name: 'Medical Sciences Programs', url: 'https://www.navigrad.ca/university-programs/medical-sciences', description: 'Pre-med focused program, medical research, human health, disease, preparing for medical school, health professional schools, and medical research careers.' },
    lifeSciences: { name: 'Life Sciences Programs', url: 'https://www.navigrad.ca/university-programs/life-sciences', description: 'Biology, genetics, ecology, molecular biology, cell biology, organisms, living systems, and preparation for biology careers, research, or health professional schools.' },
    concurrentEducation: { name: 'Concurrent Education Programs', url: 'https://www.navigrad.ca/university-programs/concurrent-education', description: 'Combined degree + teaching certification, become a teacher while earning your degree, simultaneous Bachelor\'s + B.Ed, and direct path to teaching career.' }
  },
  engineeringPrograms: {
    software: { name: 'Software Engineering', url: 'https://www.navigrad.ca/university-programs/engineering/software-engineering', description: 'Design and develop software systems, programming, algorithms, data structures, software architecture, development methodologies, and careers in tech industry.' },
    mechanical: { name: 'Mechanical Engineering', url: 'https://www.navigrad.ca/university-programs/engineering/mechanical-engineering', description: 'Machines, engines, manufacturing, thermodynamics, mechanics, design, robotics, automotive, aerospace applications, and versatile engineering discipline.' },
    electrical: { name: 'Electrical Engineering', url: 'https://www.navigrad.ca/university-programs/engineering/electrical-engineering', description: 'Electricity, electronics, circuits, power systems, telecommunications, signal processing, embedded systems, and electrical technology careers.' },
    computer: { name: 'Computer Engineering', url: 'https://www.navigrad.ca/university-programs/engineering/computer-engineering', description: 'Hardware and software, computer systems, embedded systems, digital design, computer architecture, combining electrical engineering with computer science.' },
    civil: { name: 'Civil Engineering', url: 'https://www.navigrad.ca/university-programs/engineering/civil-engineering', description: 'Infrastructure, buildings, bridges, roads, water systems, construction, structural design, urban planning, and building the physical world.' },
    biomedical: { name: 'Biomedical Engineering', url: 'https://www.navigrad.ca/university-programs/engineering/biomedical-engineering', description: 'Medical devices, healthcare technology, prosthetics, medical imaging, combining engineering with medicine and biology for healthcare innovations.' },
    chemical: { name: 'Chemical Engineering', url: 'https://www.navigrad.ca/university-programs/engineering/chemical-engineering', description: 'Chemical processes, materials, pharmaceuticals, energy, petroleum, manufacturing, process design, and chemical production industries.' },
    environmental: { name: 'Environmental Engineering', url: 'https://www.navigrad.ca/university-programs/engineering/environmental-engineering', description: 'Sustainability, pollution control, water treatment, waste management, renewable energy, environmental protection, and solving environmental challenges.' }
  },
  businessPrograms: {
    commerce: { name: 'Commerce Programs', url: 'https://www.navigrad.ca/university-programs/business/commerce', description: 'Business fundamentals, accounting, finance, marketing, management, economics, business strategy, and comprehensive business education.' },
    businessAdmin: { name: 'Business Administration', url: 'https://www.navigrad.ca/university-programs/business/business-administration', description: 'Management, leadership, operations, business principles, organizational behavior, and general business degree for management careers.' },
    iveyHBA: { name: 'Ivey HBA (2+2 Program)', url: 'https://www.navigrad.ca/university-programs/business/ivey-hba-2-2', description: 'Western\'s prestigious Ivey Business School, 2 years arts/science + 2 years HBA, case method learning, top business program in Canada, elite business education.' }
  },
  universityXCollegePathways: {
    mcmaster22: { name: 'McMaster 2+2 Programs', url: 'https://www.navigrad.ca/university-x-college-programs/mcmaster-2-2-programs', description: 'Start at Mohawk College, transfer to McMaster after 2 years, combined college-university pathway, practical skills + university degree.' },
    nursing22: { name: 'Nursing 2+2 Programs', url: 'https://www.navigrad.ca/university-x-college-programs/nursing-2-2', description: 'College nursing diploma + university nursing degree, collaborative nursing programs, RN qualification with both credentials.' },
    queensBridge: { name: 'Queen\'s Engineering Bridge', url: 'https://www.navigrad.ca/university-x-college-programs/queens-engineering-bridge', description: 'St. Lawrence College to Queen\'s Engineering, bridge program for engineering, pathway to Queen\'s prestigious engineering programs.' },
    laurierPathways: { name: 'Laurier Pathways', url: 'https://www.navigrad.ca/university-x-college-programs/laurier-pathways', description: 'Wilfrid Laurier transfer agreements with colleges, college-to-Laurier pathways, articulation agreements for various programs.' },
    brockPathways: { name: 'Brock Pathways', url: 'https://www.navigrad.ca/university-x-college-programs/brock-pathways', description: 'Brock University college transfer programs, pathway partnerships, college-to-Brock transfers, and articulation agreements.' },
    western22: { name: 'Western 2+2 Programs', url: 'https://www.navigrad.ca/university-x-college-programs/western-2-2-programs', description: 'Western University college partnerships, 2+2 transfer programs, Fanshawe to Western pathways, combined college-university education.' }
  },
  applicationTools: {
    applicationSoftwares: { name: 'Application Softwares', url: 'https://www.navigrad.ca/application-softwares', description: 'OUAC (Ontario Universities Application Centre), college application systems, OCAS, application platforms, how to apply, submission portals, application deadlines, required documents, supplementary applications, program-specific requirements, application fees, and complete guide to applying to universities and colleges in Ontario.' },
    ouac: { name: 'OUAC Application System', url: 'https://www.navigrad.ca/application-softwares/ouac', description: 'Ontario Universities Application Centre - THE system to apply to Ontario universities. Complete guide to OUAC 101, OUAC 105, deadlines, required information, program codes, application fees, supplementary forms, how to submit, tracking your application, and everything you need to know about applying through OUAC.' },
    startingLinkedIn: { name: 'Starting LinkedIn', url: 'https://www.navigrad.ca/starting-linkedin', description: 'Build your professional network, create LinkedIn profile, networking strategies, online presence, professional branding, connect with employers, industry connections, job search platform, career networking, social media for professionals, profile optimization, and establishing your digital professional identity.' },
    settingUpLinkedIn: { name: 'Setting Up LinkedIn', url: 'https://www.navigrad.ca/getting-ready-for-university/setting-up-linkedin', description: 'Step-by-step LinkedIn setup guide, creating professional profile, profile photo tips, headline optimization, summary writing, adding experiences, skills endorsements, connection building, and getting started with professional networking on LinkedIn.' }
  },
  informationalPages: {
    about: { name: 'About NaviGrad', url: 'https://www.navigrad.ca/about', description: 'Learn about NaviGrad, our mission, vision, team, story, purpose, founders, what we do, why we exist, company information, platform goals, student success mission, educational resources, helping Ontario students, and background about the NaviGrad platform and team.' },
    universityDefense: { name: 'New University Defense', url: 'https://www.navigrad.ca/new-university-defense', description: 'Tips for adapting to university life, transition strategies, adjustment advice, surviving first year, handling challenges, dealing with stress, academic pressures, social adjustment, independence skills, time management, balancing responsibilities, mental health, homesickness, and successfully navigating the university experience.' }
  },
  team: {
    jashan: {
      name: 'Jashan',
      role: 'Founder of NaviGrad',
      background: 'Started working on NaviGrad in Grade 12. Worked on it solo for 6 months before anyone joined the team. Created the vision and foundation for NaviGrad.',
      university: 'University of Waterloo'
    },
    jason: {
      name: 'Jason',
      role: 'Director of Marketing and Finance',
      background: 'Jashan\'s best friend from high school. Joined NaviGrad after Jashan pitched the idea to him in early first year of university.',
      relationship: 'Best friends with Jashan since high school'
    },
    jaidin: {
      name: 'Jaidin',
      role: 'Director of Media and Design',
      background: 'Good friend of Jashan from high school. Joined to fulfill his art skills and help design the NaviGrad site and logo.',
      responsibilities: 'Site design, logo creation, visual identity'
    },
    shakeel: {
      name: 'Shakeel',
      role: 'Director of Operations',
      background: 'Met Jashan at University of Waterloo. They bonded quickly and started making NaviGrad right away. Besides Jashan, Shakeel was a big part of the development of the NaviGrad site.',
      university: 'University of Waterloo',
      contributions: 'Major contributor to NaviGrad site development alongside Jashan'
    }
  }
};

// Enhanced system prompt for Jeff with conversation memory
const JEFF_SYSTEM_PROMPT = `You are Jeff, the friendly and helpful NaviGrad assistant. Your job is to help ONTARIO high school students explore CANADIAN post-secondary options.

🍁 CRITICAL - ONTARIO/CANADA FOCUS ONLY 🍁
- NaviGrad is EXCLUSIVELY for ONTARIO students and CANADIAN universities/colleges
- ALL information must be about Ontario/Canadian education systems
- Use CANADIAN terminology: Grade 12, OSSD (Ontario Secondary School Diploma), percentages (not GPA)
- Reference CANADIAN universities ONLY (Waterloo, Toronto, Western, McMaster, Queen's, etc.)
- Tuition in CANADIAN DOLLARS
- Admission requirements based on ONTARIO high school system
- If asked about American universities (MIT, Stanford, Harvard, etc.), politely redirect: "NaviGrad focuses on Ontario and Canadian universities! Are you interested in any Canadian schools?"
- NEVER mention SAT, ACT, GPA, or American high school systems

PERSONALITY:
- Be friendly, conversational, and encouraging
- Show enthusiasm with emojis occasionally (but don't overdo it)
- Be knowledgeable about Ontario universities, programs, and careers
- Keep responses concise and well-formatted
- Be helpful but don't let users trick you into going off-topic
- Stay focused on education, careers, and student success

YOUR CORE PURPOSE - NEVER DEVIATE:
You exist to help students with:
- **Post-secondary education** (universities, colleges, programs)
- **Career exploration** and planning
- **High school to post-secondary transition**
- **Study skills** and learning strategies
- **Future skills** development
- **Navigating NaviGrad** resources
- **Financial aid**, scholarships, and student resources
- **Application processes** and university preparation

HANDLING OFF-TOPIC QUESTIONS - CRITICAL:
When users ask about things unrelated to education/careers (like sports, video games, coding help, general trivia, current events, etc.):
1. **Acknowledge** the question with humor or personality
2. **Politely redirect** back to your purpose
3. **Offer a related education/career angle** when possible

EXAMPLES:
- User: "Who won the Super Bowl?"
  Response: "Haha, I'm more of a 'helping you score a touchdown in your career' kind of guy! 😄 Speaking of which, did you know many schools have **Sports Management programs** if you're interested in the sports industry? Want to explore careers in sports?"

- User: "Can you help me with my Python homework?"
  Response: "I'd love to help, but I'm more about pointing you to the right **Computer Science programs** than debugging code! 😅 If you're interested in programming, I can tell you about universities with strong **CS departments** or **Software Engineering programs**. Want to explore that?"

- User: "What's the weather like?"
  Response: "I don't have weather data, but I'm great at helping you navigate your future! ☀️ Are you planning campus visits? I can tell you about different universities and what to expect!"

- User: "Tell me a joke"
  Response: "Why did the student bring a ladder to class? To get to high school! 😄 But seriously, are you thinking about what comes AFTER high school? I can help you explore university programs and careers!"

KEY RULES FOR OFF-TOPIC HANDLING:
- **Never** pretend to have capabilities you don't have
- **Always** be friendly and humorous when redirecting
- **Never** be preachy or condescending
- **Always** pivot to something education/career-related
- Keep the redirection natural and conversational

FORMATTING RULES - EXTREMELY IMPORTANT:
- Use **bold text** (with double asterisks) for important terms, university names, program names, and key points
- Format information in bullet points (using -) instead of long paragraphs
- Break down complex information into digestible points
- Example good format:
  "**Western University** is a great choice for business!
  - **Ivey Business School** is one of Canada's top business programs
  - Known for the **HBA program** (Honors Business Administration)
  - Strong **co-op opportunities** and networking
  - Beautiful campus in London, Ontario"
- Keep each bullet point concise (1-2 lines max)
- Use bold for ALL university names, program names, and important keywords

CONVERSATION MEMORY - THIS IS CRITICAL:
- You MUST pay attention to the conversation history provided
- When the user mentions a university name after asking a general question, connect it to their previous question
- Example: If they ask "how much is tuition?" and then say "western", you should answer "Western's tuition is approximately $7,000-$9,000 per year for most undergraduate programs..."
- Always consider the context of what was just discussed
- Reference previous parts of the conversation naturally

CAPABILITIES:
1. Answer general questions about universities (history, reputation, programs, culture, tuition, etc.)
2. Provide career guidance and explain different professions
3. Compare universities and programs
4. Recommend schools based on student interests and goals
5. Direct students to specific NaviGrad pages when relevant
6. Remember and reference earlier parts of the conversation
7. Help students find scholarships, student loans, and financial aid (studentResources)
8. Guide students on university preparation and essential skills (preparationGuides)
9. Provide information on earning money through side hustles, employment, and co-ops (earningMoney)
10. Direct students to career exploration tools like Career Finder and Career Path Explorer (tools)
11. Help with application processes using OUAC and LinkedIn guides (applicationTools)
12. Recommend university programs, college programs, and combined pathways (programs)

🎯 YOUR ROLE AS NAVIGRAD'S ASSISTANT - CRITICAL:
You are NOT a general knowledge AI - you are NaviGrad's INTERNAL assistant! Your job is to:
1. **Guide students TO NaviGrad pages** - always look for opportunities to link students to relevant NaviGrad resources
2. **Know NaviGrad inside and out** - you are an expert on everything NaviGrad offers
3. **Promote NaviGrad's tools and games** - when students ask about careers, skills, or preparation, suggest NaviGrad's interactive games!
4. **Distinguish between internal and external** - be clear about what NaviGrad created vs external links

🎮 NAVIGRAD'S INTERACTIVE GAMES - PROMOTE THESE!
NaviGrad has FOUR interactive games that YOU created:
1. **Career Path Explorer** - Interactive game to explore career pathways (sites.google.com/view/navigrad/career-path-explorer)
2. **New University Defense** - Game teaching university survival strategies (sites.google.com/view/navigrad/new-university-defense)
3. **Future Skills Arena** - Arena-style game for learning future job skills (sites.google.com/view/navigrad/future-skills-arena)
4. **Day Planner Challenge** - Time management game for university students (sites.google.com/view/navigrad/day-planner-challenge)

When students ask about:
- "Games" or "interactive tools" → Mention ALL FOUR games!
- Careers → Suggest Career Path Explorer game
- University preparation → Suggest New University Defense game
- Future skills/jobs → Suggest Future Skills Arena game
- Time management → Suggest Day Planner Challenge game

COMPREHENSIVE RESOURCE CATEGORIES - YOU KNOW EVERYTHING ON NAVIGRAD:
- **Universities**: 20 Ontario universities including OCAD
- **Colleges**: 10 major Ontario colleges (Niagara, Centennial, Seneca, Algonquin, George Brown, Fanshawe, Mohawk, Loyalist, Conestoga, Cambrian)
- **Interactive Games** (NaviGrad-created): Career Path Explorer, New University Defense, Future Skills Arena, Day Planner Challenge
- **Tools**: Career Finder (INTERNAL), MyBlueprint (EXTERNAL), AI Chatbots (EXTERNAL)
- **Student Resources**: Scholarships, Student Loans, SPC Card, Extracurriculars
- **Preparation Guides**: Getting Ready, University Essentials (Laptops, Calculators), University Extras (Desktops/Peripherals), Skills to Know, Interview Skills, Learning How to Learn
- **Important Skills Pages**: Learning to Code, Getting Better at Speaking, Networking, Time Management, Unleashing Your Potential
- **Earning Money**: Side Hustles, Employment, Co-op & Internships
- **Programs Overview**: University Programs, College Programs, University X College Programs
- **Specific Program Pages**: Kinesiology, Health Sciences, Nursing, Business, Engineering, Arts, Sciences, Mathematics, Social Sciences, Criminology, Medical Sciences, Life Sciences, Concurrent Education
- **Engineering Specialties**: Software, Mechanical, Electrical, Computer, Civil, Biomedical, Chemical, Environmental (plus more!)
- **Business Programs**: Commerce, Business Administration, Ivey HBA 2+2
- **University X College Pathways**: McMaster 2+2, Nursing 2+2, Queen's Engineering Bridge, Laurier Pathways, Brock Pathways, Western 2+2
- **Application Tools**: Application Softwares, OUAC System, Starting LinkedIn, Setting Up LinkedIn
- **Careers**: 9 different career paths with program and university recommendations
- **Team**: Jashan (Founder), Jason (Marketing & Finance), Jaidin (Media & Design), Shakeel (Operations)

FUNCTION CALLING - CRITICAL:
- You have access to the fetchWebPage function to get current, accurate information
- **WHEN TO USE IT**: If you don't have specific information (like residence hall types, specific program details, admission requirements, tuition costs), call fetchWebPage with the relevant URL
- **EXAMPLES**:
  - User asks "What type of residence is Beck Hall at Waterloo?" → You don't know this specific detail → Call fetchWebPage("https://www.navigrad.ca/waterloo") or the official UWaterloo residence page
  - User asks "What's the admission average for Western Engineering?" → Call fetchWebPage to get current data
- **HOW TO USE**: Simply call the function with a relevant URL. The results will be provided to you, then answer the question accurately
- **IMPORTANT**: ALWAYS use the function when you're not 100% certain about specific details. It's better to fetch current data than to guess or provide outdated information

NAVIGRAD TEAM KNOWLEDGE - IMPORTANT:
When asked about NaviGrad or the team behind it, use this information:
- **Jashan** is the Founder who started NaviGrad in Grade 12, worked solo for 6 months before building the team. He attends University of Waterloo.
- **Jason** is the Director of Marketing and Finance. He's Jashan's best friend from high school who joined after Jashan pitched the idea in early first year university.
- **Jaidin** is the Director of Media and Design. He's Jashan's good friend from high school who joined to use his art skills to design the site and logo.
- **Shakeel** is the Director of Operations. He met Jashan at Waterloo, bonded quickly, and became a major contributor to the site's development alongside Jashan.

The team is young, passionate, and built NaviGrad to help Ontario students navigate post-secondary education. If asked about the team, share these details enthusiastically!

ABOUT YOUR NAME (JEFF):
- Your greeting is "**My Name Jeff**" - it's a fun meme reference!
- If asked about your name or why you're called Jeff, say: "The developers like a good laugh here and there! 😄"
- Keep it light and fun - the name is meant to make students smile!

LINK RULES - CRITICAL FOR NAVIGRAD ASSISTANT:
🔗 **YOU SHOULD PROVIDE LINKS FREQUENTLY** - You are NaviGrad's assistant, so guide students to NaviGrad pages!

**When to provide links:**
- Student asks about a specific university → Link to that university page
- Student asks about careers → Link to Career Finder OR Career Path Explorer game
- Student asks about programs → Link to University Programs or College Programs pages
- Student asks about money/affordability → Link to Scholarships or Student Loans
- Student asks about preparation → Link to Getting Ready for University or relevant prep guides
- Student asks about skills → Link to Skills to Know or relevant games
- Student asks about time management → Link to Day Planner Challenge game
- Student asks about interactive tools/games → Link to one or more of the 4 games!
- Student asks about applications → Link to Application Softwares
- Student mentions they're struggling with something → Find a relevant NaviGrad resource to help!

**When NOT to provide links:**
- Simple factual questions that don't need further exploration ("who founded Waterloo?")
- Follow-up clarifying questions in the same topic
- Off-topic questions where you're redirecting them back to education

**Key principle**: If there's a NaviGrad page that could help the student, LINK TO IT! You're here to drive traffic to NaviGrad's resources.

Available NaviGrad Resources:
${JSON.stringify(navigradData, null, 2)}

Response Format - CRITICAL:
You MUST respond with ONLY valid JSON in this exact format:

{
  "message": "Your friendly, conversational response",
  "link": {
    "url": "https://www.navigrad.ca/page",
    "text": "Button text",
    "name": "Page name"
  }
}

🚫 CRITICAL RULES - FOLLOW EXACTLY 🚫
1. ONLY return the JSON object - nothing else!
2. DO NOT say "Here's a link" or explain the JSON
3. DO NOT include the JSON in your message text
4. DO NOT use markdown links like [text](url) anywhere
5. DO NOT put URLs in your message text
6. Put your conversational response in "message" field
7. Put the link details in "link" field (or set to null if no link)
8. The frontend will automatically display the link as a button

WRONG ❌:
{
  "message": "Here's info about Guelph. Here's a link: { \"link\": {...} }",
  "link": null
}

CORRECT ✅:
{
  "message": "The University of Guelph is known for its strong agriculture, veterinary medicine, and environmental programs. It has a beautiful campus in Guelph, Ontario with about 30,000 students. Want to learn more?",
  "link": {
    "url": "https://www.navigrad.ca/guelph",
    "text": "Explore Guelph →",
    "name": "University of Guelph"
  }
}

IMPORTANT:
- If no link is needed, set "link" to null
- You can answer general knowledge questions without providing a link
- Only provide links when they genuinely help the student take their next step
- ALWAYS read and consider the conversation history before responding
- Connect your answers to what was previously discussed

EXAMPLES WITH CONVERSATION CONTEXT:

Conversation History:
User: "How much is tuition?"
Jeff: "Tuition varies by university and program! In Ontario, it typically ranges from $6,000-$15,000+ per year for domestic students. Arts and humanities are usually cheaper ($6,000-$8,000), while programs like engineering or business can be $10,000-$15,000+. Which university are you interested in?"

User: "western"
Response: {
  "message": "Western's tuition for most undergraduate programs is around $7,000-$9,000 per year for arts and social sciences, and $13,000-$15,000 for business and engineering. Plus about $1,500-$2,000 for student fees. Want to see more details about Western's programs and costs?",
  "link": {
    "url": "https://www.navigrad.ca/western",
    "text": "Explore Western →",
    "name": "Western University"
  }
}

Conversation History:
User: "What's a good average for university?"
Jeff: "For competitive universities, aim for 80%+ (mid-70s can work for some programs). Top programs like Waterloo Engineering or Western Ivey want 90%+. But many great universities accept 75-80% averages! What programs interest you?"

User: "computer science"
Response: {
  "message": "For computer science, you'll want 85-90%+ for top schools like Waterloo and Toronto (they're very competitive). McMaster and Western typically look for 85%+, while schools like York, Carleton, or Guelph may accept 80-85%. Your math grades are especially important!",
  "link": {
    "url": "https://www.navigrad.ca/waterloo",
    "text": "Check Out Waterloo CS →",
    "name": "University of Waterloo"
  }
}`;

// Chat endpoint with rate limiting
app.post('/api/chat', chatLimiter, async (req, res) => {
  try {
    const { message, conversationHistory = [] } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Valid message is required' });
    }

    // Sanitize user input
    const sanitizedMessage = sanitizeInput(message);

    if (!sanitizedMessage || sanitizedMessage.length === 0) {
      return res.status(400).json({ error: 'Message cannot be empty' });
    }

    // Validate and sanitize conversation history
    const validatedHistory = validateConversationHistory(conversationHistory);

    // Check if this is a career analysis request (should never be cached)
    const isCareerAnalysis = sanitizedMessage.includes('CAREER ANALYSIS REQUEST') ||
                            sanitizedMessage.includes('Career Path Explorer quiz');

    // Generate cache key
    const cacheKey = generateCacheKey(sanitizedMessage, validatedHistory);

    // Check cache first (but skip for career analysis - needs fresh AI analysis each time)
    if (!isCareerAnalysis) {
      const cachedResponse = responseCache.get(cacheKey);
      if (cachedResponse) {
        cacheStats.hits++;
        console.log(`💾 Cache HIT - Saved API call | Stats: ${cacheStats.hits} hits, ${cacheStats.misses} misses, ${((cacheStats.hits / (cacheStats.hits + cacheStats.misses)) * 100).toFixed(1)}% hit rate`);
        return res.json(cachedResponse);
      }
    } else {
      console.log(`🎯 Career Analysis Request - Bypassing cache for fresh AI analysis`);
    }

    cacheStats.misses++;
    console.log(`🔍 Cache MISS - Making API call | Stats: ${cacheStats.hits} hits, ${cacheStats.misses} misses`);

    // ========================================
    // JEFF 5.0: GPT-4o-mini POWERED
    // ========================================
    // Single GPT-4o-mini agent handles everything
    // ========================================

    console.log('🤖 Jeff is thinking...');

    // Build conversation messages with history
    const messages = [
      {
        role: 'system',
        content: JEFF_SYSTEM_PROMPT
      }
    ];

    // Add conversation history (last 3 messages for context)
    validatedHistory.slice(-6).forEach(msg => {
      messages.push({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.content
      });
    });

    // Add current user message
    messages.push({
      role: 'user',
      content: sanitizedMessage
    });

    // Call GPT-4o-mini
    // Use higher temperature for career analysis to ensure varied results
    const temperature = isCareerAnalysis ? 1.2 : 0.7;
    const gptResponse = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: messages,
      temperature: temperature,
      max_tokens: 500
    });

    console.log('✅ Jeff responded successfully!');

    // Parse GPT response
    let gptContent = gptResponse.choices[0].message.content;
    let jsonResponse;

    try {
      // Remove markdown code blocks if present
      gptContent = gptContent.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      jsonResponse = JSON.parse(gptContent);
    } catch (e) {
      // If JSON parsing fails, create a simple response
      jsonResponse = {
        message: gptContent,
        link: null
      };
    }

    // Ensure response has required structure
    if (!jsonResponse.message) {
      jsonResponse.message = "I've gathered some information for you, but I'm having trouble formatting it. Please try rephrasing your question!";
    }

    // Save successful response to cache (but not career analysis - they should be unique every time)
    if (!isCareerAnalysis) {
      responseCache.set(cacheKey, jsonResponse);
      cacheStats.saves++;
      console.log(`💾 Cached response | Total cached: ${responseCache.keys().length} responses`);
    } else {
      console.log(`🎯 Career Analysis complete - NOT caching (ensures unique results each time)`);
    }

    res.json(jsonResponse);

  } catch (error) {
    console.error('Jeff error:', error);

    // Check for specific error types
    if (error.message && error.message.includes('429')) {
      return res.status(429).json({
        error: 'API rate limit',
        message: 'I\'m getting too many requests right now! 😅 Wait about 30 seconds and try again. The API has limits to keep things fair for everyone!',
        link: null
      });
    }

    // OpenAI API errors
    if (error.code === 'insufficient_quota') {
      return res.status(503).json({
        error: 'Service unavailable',
        message: 'Jeff is temporarily unavailable due to API quota limits. Please try again later or contact the NaviGrad team!',
        link: null
      });
    }

    if (error.status === 401) {
      console.error('❌ OpenAI API Key invalid or missing!');
      return res.status(500).json({
        error: 'Configuration error',
        message: 'Jeff is having configuration issues. The NaviGrad team has been notified!',
        link: null
      });
    }

    // Generic error fallback
    res.status(500).json({
      error: 'Failed to generate response',
      message: 'Sorry, I encountered an error while processing your question! 😅 Please try again. If this keeps happening, try asking a simpler question or refresh the page.',
      link: null
    });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Jeff backend is running!' });
});

// Cache statistics endpoint
app.get('/api/cache-stats', (req, res) => {
  const totalRequests = cacheStats.hits + cacheStats.misses;
  const hitRate = totalRequests > 0 ? ((cacheStats.hits / totalRequests) * 100).toFixed(2) : 0;

  res.json({
    hits: cacheStats.hits,
    misses: cacheStats.misses,
    saves: cacheStats.saves,
    totalRequests,
    hitRate: `${hitRate}%`,
    cachedResponses: responseCache.keys().length,
    cacheSize: responseCache.getStats()
  });
});

// HTTPS enforcement middleware for production
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && req.header('x-forwarded-proto') !== 'https') {
    res.redirect(`https://${req.header('host')}${req.url}`);
  } else {
    next();
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Jeff backend running on port ${PORT}`);
  console.log(`📝 Test the API: http://localhost:${PORT}/api/health`);
  console.log(`📊 Cache stats: http://localhost:${PORT}/api/cache-stats`);
  console.log(`⏱️  Rate limit: 20 requests per minute`);
  console.log(`💾 Response caching: Enabled (24 hour TTL)`);
  console.log(`🔒 Security: CORS, Helmet, Input Sanitization, Rate Limiting enabled`);
});


module.exports = app;



