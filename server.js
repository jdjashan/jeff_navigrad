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

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy - needed for correct IP detection behind reverse proxies
app.set('trust proxy', 1);

// Security Middleware
app.use(helmet()); // Adds security headers

// CORS configuration - restrict to NaviGrad domain
const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = [
      'https://www.navigrad.ca',
      'https://navigrad.ca',
      'http://localhost:3000', // For local development
      'http://localhost:5500', // For local development
      'http://127.0.0.1:5500'  // For local development
    ];

    // Allow requests with no origin (like mobile apps or curl requests) in development
    if (!origin && process.env.NODE_ENV !== 'production') {
      return callback(null, true);
    }

    if (allowedOrigins.indexOf(origin) !== -1 || !origin) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
};

app.use(cors(corsOptions));

// Body parsing with size limits
app.use(express.json({ limit: '10kb' })); // Limit request body to 10kb
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// Sanitize data against NoSQL injection
app.use(mongoSanitize());

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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
    brock: { name: 'Brock University', url: 'https://www.navigrad.ca/brock', location: 'St. Catharines' },
    western: { name: 'Western University', url: 'https://www.navigrad.ca/western', location: 'London' },
    waterloo: { name: 'University of Waterloo', url: 'https://www.navigrad.ca/waterloo', location: 'Waterloo' },
    toronto: { name: 'University of Toronto', url: 'https://www.navigrad.ca/toronto', location: 'Toronto' },
    mcmaster: { name: 'McMaster University', url: 'https://www.navigrad.ca/mcmaster', location: 'Hamilton' },
    queens: { name: 'Queen\'s University', url: 'https://www.navigrad.ca/queens', location: 'Kingston' },
    ottawa: { name: 'University of Ottawa', url: 'https://www.navigrad.ca/ottawa', location: 'Ottawa' },
    guelph: { name: 'University of Guelph', url: 'https://www.navigrad.ca/guelph', location: 'Guelph' },
    ryerson: { name: 'Toronto Metropolitan University', url: 'https://www.navigrad.ca/ryerson', location: 'Toronto' },
    york: { name: 'York University', url: 'https://www.navigrad.ca/york', location: 'Toronto' },
    carleton: { name: 'Carleton University', url: 'https://www.navigrad.ca/carleton', location: 'Ottawa' },
    laurier: { name: 'Wilfrid Laurier University', url: 'https://www.navigrad.ca/laurier', location: 'Waterloo' },
    windsor: { name: 'University of Windsor', url: 'https://www.navigrad.ca/windsor', location: 'Windsor' },
    lakehead: { name: 'Lakehead University', url: 'https://www.navigrad.ca/lakehead', location: 'Thunder Bay' },
    trent: { name: 'Trent University', url: 'https://www.navigrad.ca/trent', location: 'Peterborough' },
    nipissing: { name: 'Nipissing University', url: 'https://www.navigrad.ca/nipissing', location: 'North Bay' },
    algoma: { name: 'Algoma University', url: 'https://www.navigrad.ca/algoma', location: 'Sault Ste. Marie' },
    laurentian: { name: 'Laurentian University', url: 'https://www.navigrad.ca/laurentian', location: 'Sudbury' },
    ocad: { name: 'OCAD University', url: 'https://www.navigrad.ca/ocad', location: 'Toronto' }
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
    careerFinder: { name: 'Career Finder', url: 'https://www.navigrad.ca/career-finder', description: 'Interactive tool to discover and explore careers that match your interests, skills, passions, strengths, personality, and academic preferences. Find job options, career paths, profession ideas, and occupation suggestions based on what you enjoy doing.' },
    startPage: { name: 'Start Page', url: 'https://www.navigrad.ca/start', description: 'Complete guide to begin your post-secondary journey in Ontario. Learn about the application process, OUAC, choosing programs, visiting campuses, finding your path, getting started with university or college planning, and first steps for grade 11-12 students.' },
    myBlueprint: { name: 'MyBlueprint', url: 'https://www.navigrad.ca/myblueprint', description: 'Comprehensive career and education planning platform tool. Create portfolios, explore pathways, plan courses, set goals, track progress, research programs, build resumes, discover interests, and develop your academic and career roadmap for high school and beyond.' },
    careerPathExplorer: { name: 'Career Path Explorer', url: 'https://www.navigrad.ca/career-path-explorer', description: 'Deep dive into different career pathways, trajectories, progressions, and journey options. Understand various professional routes, job advancement, industry transitions, specialization paths, and how to navigate your way from education to employment in different fields.' },
    aiChatbots: { name: 'Best AI Chatbots', url: 'https://www.navigrad.ca/best-ai-chatbots', description: 'Curated list of the best AI tools, chatbots, assistants, and artificial intelligence resources to help with studying, homework, research, writing, learning, tutoring, essay help, assignment assistance, and academic success. Includes ChatGPT, educational AI, and study tools.' },
    futureSkillsArena: { name: 'Future Skills Arena', url: 'https://www.navigrad.ca/future-skills-arena', description: 'Learn about in-demand skills for the future job market, emerging careers, growing industries, technology trends, workplace competencies, 21st century abilities, soft skills, technical skills, digital literacy, and what employers will look for in tomorrow\'s workforce.' }
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
    interviewSkills: { name: 'Interview Skills', url: 'https://www.navigrad.ca/interview-skills', description: 'Master interview techniques, preparation strategies, answering questions, behavioral interviews, STAR method, confident communication, body language, dress code, follow-up etiquette, common questions, how to prepare, tips to ace university admission interviews, scholarship interviews, and job interviews.' },
    importantSkills: { name: 'Important Skills', url: 'https://www.navigrad.ca/important-skills', description: 'Key competencies, vital abilities, crucial skills, professional development, workplace readiness, transferable skills, soft skills, hard skills, employability factors, career success skills, leadership, teamwork, problem-solving, and competencies for academic achievement and future career advancement.' }
  },
  earningMoney: {
    sideHustles: { name: 'Side Hustles', url: 'https://www.navigrad.ca/side-hustles', description: 'Ways to earn extra money, make cash while studying, freelancing opportunities, gig economy jobs, passive income ideas, online money-making, entrepreneurship for students, part-time business ideas, flexible income sources, and creative ways to fund your education while maintaining academic success.' },
    employment: { name: 'Employment', url: 'https://www.navigrad.ca/employment', description: 'Part-time jobs, full-time work, student employment opportunities, on-campus jobs, off-campus positions, work-study programs, summer jobs, career opportunities, job search strategies, resume building, where to find work, hiring resources, and employment options for students.' },
    coopInternships: { name: 'Co-op & Internships', url: 'https://www.navigrad.ca/coop-internships', description: 'Gain valuable work experience, paid internships, co-op programs, work-integrated learning, industry placements, hands-on training, professional development, networking opportunities, career exploration, employer connections, and programs that combine academic study with real-world workplace experience.' }
  },
  programs: {
    universityPrograms: { name: 'University Programs', url: 'https://www.navigrad.ca/university-programs', description: 'Browse and explore university programs, majors, degrees, fields of study, academic disciplines, bachelor programs, undergraduate options, subject areas, faculties, departments, specialized streams, honors programs, combined degrees, program requirements, and detailed information about what you can study at Ontario universities.' },
    collegePrograms: { name: 'College Programs', url: 'https://www.navigrad.ca/college-programs', description: 'Explore Ontario college diploma programs, certificate courses, advanced diplomas, vocational training, technical education, skilled trades, applied learning, hands-on programs, career-focused education, two-year programs, three-year programs, college majors, and practical training options at Ontario colleges.' },
    universityXCollege: { name: 'University X College Programs', url: 'https://www.navigrad.ca/university-x-college', description: 'Combined university-college pathways, transfer programs, articulation agreements, 2+2 programs, college-to-university transfers, dual credentials, collaborative programs, pathway opportunities, bridging programs, and options to combine college diplomas with university degrees for comprehensive education.' }
  },
  applicationTools: {
    applicationSoftwares: { name: 'Application Softwares', url: 'https://www.navigrad.ca/application-softwares', description: 'OUAC (Ontario Universities Application Centre), college application systems, OCAS, application platforms, how to apply, submission portals, application deadlines, required documents, supplementary applications, program-specific requirements, application fees, and complete guide to applying to universities and colleges in Ontario.' },
    startingLinkedIn: { name: 'Starting LinkedIn', url: 'https://www.navigrad.ca/starting-linkedin', description: 'Build your professional network, create LinkedIn profile, networking strategies, online presence, professional branding, connect with employers, industry connections, job search platform, career networking, social media for professionals, profile optimization, and establishing your digital professional identity.' }
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
const JEFF_SYSTEM_PROMPT = `You are Jeff, the friendly and helpful NaviGrad assistant. Your job is to help Ontario high school students explore post-secondary options.

PERSONALITY:
- Be friendly, conversational, and encouraging
- Show enthusiasm with emojis occasionally (but don't overdo it)
- Be knowledgeable about Ontario universities, programs, and careers
- Keep responses concise (2-4 sentences for general questions, longer for detailed explanations)

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

RESOURCE CATEGORIES YOU HAVE ACCESS TO:
- **Universities**: 19 Ontario universities with details
- **Tools**: Career Finder, MyBlueprint, Career Path Explorer, AI Chatbots, Future Skills Arena
- **Student Resources**: Scholarships, Student Loans, SPC Card, Extracurriculars
- **Preparation Guides**: Getting Ready for University, University Essentials, Skills to Know, Interview Skills
- **Earning Money**: Side Hustles, Employment, Co-op & Internships
- **Programs**: University Programs, College Programs, University X College Programs
- **Application Tools**: Application Softwares, Starting LinkedIn
- **Careers**: 9 different career paths with program and university recommendations
- **Team**: The NaviGrad team - Jashan (Founder), Jason (Director of Marketing & Finance), Jaidin (Director of Media & Design), Shakeel (Director of Operations)

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

LINK RULES:
- Provide a NaviGrad link when it's relevant and helpful
- Don't force a link into every response
- If answering a general question (like "who founded Waterloo?"), just answer it naturally
- If the student wants to learn more about a specific university, program, career, OR needs help with scholarships, applications, career exploration, preparation, etc., THEN provide the appropriate link
- Use the new resource categories (tools, studentResources, preparationGuides, earningMoney, programs, applicationTools) to provide comprehensive guidance
- When asked about the NaviGrad team, provide the About NaviGrad link for more details

Available NaviGrad Resources:
${JSON.stringify(navigradData, null, 2)}

Response Format:
{
  "message": "Your friendly, conversational response that references previous conversation context when relevant",
  "link": {
    "url": "https://www.navigrad.ca/page",
    "text": "Button text",
    "name": "Page name"
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

    // Generate cache key
    const cacheKey = generateCacheKey(sanitizedMessage, validatedHistory);

    // Check cache first
    const cachedResponse = responseCache.get(cacheKey);
    if (cachedResponse) {
      cacheStats.hits++;
      console.log(`💾 Cache HIT - Saved API call | Stats: ${cacheStats.hits} hits, ${cacheStats.misses} misses, ${((cacheStats.hits / (cacheStats.hits + cacheStats.misses)) * 100).toFixed(1)}% hit rate`);
      return res.json(cachedResponse);
    }

    cacheStats.misses++;
    console.log(`🔍 Cache MISS - Making API call | Stats: ${cacheStats.hits} hits, ${cacheStats.misses} misses`);

    // Initialize the model with function calling enabled
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      tools: [{ functionDeclarations: [fetchWebPageDeclaration] }]
    });

    // Build conversation context - use validated history
    let prompt = `${JEFF_SYSTEM_PROMPT}\n\n`;

    // Include validated conversation history
    if (validatedHistory.length > 0) {
      prompt += `CONVERSATION HISTORY (Read this carefully before responding):\n`;
      validatedHistory.forEach(msg => {
        const role = msg.role === 'user' ? 'User' : 'Jeff';
        prompt += `${role}: ${msg.content}\n`;
      });
      prompt += `\n`;
    }

    prompt += `CURRENT USER MESSAGE: ${sanitizedMessage}\n\nJeff (respond in JSON format, referencing conversation context if relevant):`;

    // Generate response with function calling support
    let jsonResponse;
    let functionCallAttempts = 0;
    const maxFunctionCalls = 3; // Prevent infinite loops

    while (functionCallAttempts < maxFunctionCalls) {
      try {
        const result = await model.generateContent(prompt);
        const response = result.response;

        // Check if there are function calls
        const functionCalls = response.functionCalls();

        if (functionCalls && functionCalls.length > 0) {
          functionCallAttempts++;

          // Execute all function calls
          const functionResponses = await Promise.all(
            functionCalls.map(async (call) => {
              if (call.name === 'fetchWebPage') {
                const webResult = await fetchWebPage(call.args.url);
                return {
                  name: call.name,
                  response: webResult
                };
              }
              return null;
            })
          );

          // Continue conversation with function results
          prompt += `\n\nFUNCTION RESULTS:\n${JSON.stringify(functionResponses, null, 2)}\n\nNow provide your final response in JSON format based on this information:`;
          continue; // Loop again with function results
        }

        // No function calls, process the text response
        let text = response.text();

        // Try to parse JSON response
        try {
          // Remove markdown code blocks if present
          text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
          jsonResponse = JSON.parse(text);
          break; // Success, exit loop
        } catch (e) {
          // If JSON parsing fails, create a simple response
          jsonResponse = {
            message: text,
            link: null
          };
          break;
        }
      } catch (error) {
        throw error;
      }
    }

    if (!jsonResponse) {
      jsonResponse = {
        message: "I'm having trouble processing your request. Please try again!",
        link: null
      };
    }

    // Save successful response to cache
    responseCache.set(cacheKey, jsonResponse);
    cacheStats.saves++;
    console.log(`💾 Cached response | Total cached: ${responseCache.keys().length} responses`);

    res.json(jsonResponse);

  } catch (error) {
    console.error('Error:', error);
    
    // Check if it's a rate limit error from Google
    if (error.message && error.message.includes('429')) {
      return res.status(429).json({ 
        error: 'API rate limit',
        message: 'I\'m getting too many requests right now! 😅 Wait about 30 seconds and try again. Google\'s API has limits to keep things fair for everyone!',
        link: null
      });
    }
    
    res.status(500).json({ 
      error: 'Failed to generate response',
      message: 'Sorry, I encountered an error. Please try again! If this keeps happening, the AI service might be temporarily busy.',
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


