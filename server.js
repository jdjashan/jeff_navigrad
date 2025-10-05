// server.js - Backend API for Jeff with Google Gemini
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');
const axios = require('axios');
const cheerio = require('cheerio');
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
    quiz: { name: 'Program Selector Quiz', url: 'https://www.navigrad.ca/quiz' },
    colleges: { name: 'College Information', url: 'https://www.navigrad.ca/colleges' },
    apprenticeship: { name: 'Apprenticeship Programs', url: 'https://www.navigrad.ca/apprenticeship' },
    shop: { name: 'University Essentials Shop', url: 'https://www.navigrad.ca/shop' },
    home: { name: 'Home Page', url: 'https://www.navigrad.ca/' }
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
    careerFinder: { name: 'Career Finder', url: 'https://www.navigrad.ca/career-finder', description: 'Discover careers that match your interests and skills' },
    startPage: { name: 'Start Page', url: 'https://www.navigrad.ca/start', description: 'Begin your post-secondary journey' },
    myBlueprint: { name: 'MyBlueprint', url: 'https://www.navigrad.ca/myblueprint', description: 'Career and education planning tool' },
    careerPathExplorer: { name: 'Career Path Explorer', url: 'https://www.navigrad.ca/career-path-explorer', description: 'Explore different career pathways' },
    aiChatbots: { name: 'Best AI Chatbots', url: 'https://www.navigrad.ca/best-ai-chatbots', description: 'AI tools to help with studying and research' },
    futureSkillsArena: { name: 'Future Skills Arena', url: 'https://www.navigrad.ca/future-skills-arena', description: 'Learn about in-demand skills for the future' }
  },
  studentResources: {
    scholarships: { name: 'Scholarships', url: 'https://www.navigrad.ca/scholarships', description: 'Find scholarships and financial aid opportunities' },
    studentLoans: { name: 'Student Loans', url: 'https://www.navigrad.ca/student-loans', description: 'Learn about OSAP and student loan options' },
    spc: { name: 'SPC Card', url: 'https://www.navigrad.ca/spc', description: 'Student Price Card discounts and benefits' },
    extracurriculars: { name: 'Extracurriculars', url: 'https://www.navigrad.ca/extracurriculars', description: 'Clubs, sports, and activities to enhance your application' }
  },
  preparationGuides: {
    gettingReady: { name: 'Getting Ready for University', url: 'https://www.navigrad.ca/getting-ready-for-university', description: 'Essential preparation tips' },
    universityEssentials: { name: 'University Essentials', url: 'https://www.navigrad.ca/university-essentials', description: 'Must-have items for university life' },
    universityExtras: { name: 'University Extras', url: 'https://www.navigrad.ca/university-extras', description: 'Nice-to-have items to enhance your experience' },
    skillsToKnow: { name: 'Skills To Know', url: 'https://www.navigrad.ca/skills-to-know', description: 'Essential skills for success' },
    interviewSkills: { name: 'Interview Skills', url: 'https://www.navigrad.ca/interview-skills', description: 'Ace your university and job interviews' },
    importantSkills: { name: 'Important Skills', url: 'https://www.navigrad.ca/important-skills', description: 'Key competencies for academic and career success' }
  },
  earningMoney: {
    sideHustles: { name: 'Side Hustles', url: 'https://www.navigrad.ca/side-hustles', description: 'Ways to earn money while studying' },
    employment: { name: 'Employment', url: 'https://www.navigrad.ca/employment', description: 'Part-time and full-time job opportunities' },
    coopInternships: { name: 'Co-op & Internships', url: 'https://www.navigrad.ca/coop-internships', description: 'Gain work experience through co-op and internship programs' }
  },
  programs: {
    universityPrograms: { name: 'University Programs', url: 'https://www.navigrad.ca/university-programs', description: 'Browse programs by field of study' },
    collegePrograms: { name: 'College Programs', url: 'https://www.navigrad.ca/college-programs', description: 'Explore college diploma and certificate programs' },
    universityXCollege: { name: 'University X College Programs', url: 'https://www.navigrad.ca/university-x-college', description: 'Combined university-college pathways' }
  },
  applicationTools: {
    applicationSoftwares: { name: 'Application Softwares', url: 'https://www.navigrad.ca/application-softwares', description: 'OUAC, college applications, and other platforms' },
    startingLinkedIn: { name: 'Starting LinkedIn', url: 'https://www.navigrad.ca/starting-linkedin', description: 'Build your professional network' }
  },
  informationalPages: {
    about: { name: 'About NaviGrad', url: 'https://www.navigrad.ca/about', description: 'Learn about NaviGrad and our mission' },
    universityDefense: { name: 'New University Defense', url: 'https://www.navigrad.ca/new-university-defense', description: 'Tips for adapting to university life' }
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

FUNCTION CALLING - CRITICAL:
- You have access to the fetchWebPage function to get current, accurate information
- **WHEN TO USE IT**: If you don't have specific information (like residence hall types, specific program details, admission requirements, tuition costs), call fetchWebPage with the relevant URL
- **EXAMPLES**:
  - User asks "What type of residence is Beck Hall at Waterloo?" → You don't know this specific detail → Call fetchWebPage("https://www.navigrad.ca/waterloo") or the official UWaterloo residence page
  - User asks "What's the admission average for Western Engineering?" → Call fetchWebPage to get current data
- **HOW TO USE**: Simply call the function with a relevant URL. The results will be provided to you, then answer the question accurately
- **IMPORTANT**: ALWAYS use the function when you're not 100% certain about specific details. It's better to fetch current data than to guess or provide outdated information

LINK RULES:
- Provide a NaviGrad link when it's relevant and helpful
- Don't force a link into every response
- If answering a general question (like "who founded Waterloo?"), just answer it naturally
- If the student wants to learn more about a specific university, program, career, OR needs help with scholarships, applications, career exploration, preparation, etc., THEN provide the appropriate link
- Use the new resource categories (tools, studentResources, preparationGuides, earningMoney, programs, applicationTools) to provide comprehensive guidance

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
  console.log(`⏱️  Rate limit: 20 requests per minute`);
  console.log(`🔒 Security: CORS, Helmet, Input Sanitization, Rate Limiting enabled`);
});


module.exports = app;


