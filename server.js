// server.js - Backend API for Jeff with Google Gemini
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Rate limiting - track requests per IP
const requestTracker = new Map();
const RATE_LIMIT = {
  windowMs: 60000, // 1 minute
  maxRequests: 20   // 20 requests per minute
};

function checkRateLimit(ip) {
  const now = Date.now();
  const userRequests = requestTracker.get(ip) || [];
  
  // Remove old requests outside the time window
  const recentRequests = userRequests.filter(timestamp => now - timestamp < RATE_LIMIT.windowMs);
  
  if (recentRequests.length >= RATE_LIMIT.maxRequests) {
    return false; // Rate limit exceeded
  }
  
  recentRequests.push(now);
  requestTracker.set(ip, recentRequests);
  return true;
}

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

LINK RULES:
- Provide a NaviGrad link when it's relevant and helpful
- Don't force a link into every response
- If answering a general question (like "who founded Waterloo?"), just answer it naturally
- If the student wants to learn more about a specific university, program, or career, THEN provide a link

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
app.post('/api/chat', async (req, res) => {
  try {
    const { message, conversationHistory = [] } = req.body;
    const userIp = req.ip || req.connection.remoteAddress;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Check rate limit
    if (!checkRateLimit(userIp)) {
      return res.status(429).json({ 
        error: 'Rate limit exceeded',
        message: 'Whoa there! You\'re asking questions too fast! 😅 Give me a moment to catch my breath. Try again in a minute!',
        link: null
      });
    }

    // Initialize the model - UPDATED to gemini-2.0-flash-exp
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    // Build conversation context - include MORE history for better context
    let prompt = `${JEFF_SYSTEM_PROMPT}\n\n`;
    
    // Include recent conversation history (last 10 messages for better context)
    if (conversationHistory.length > 0) {
      prompt += `CONVERSATION HISTORY (Read this carefully before responding):\n`;
      conversationHistory.slice(-10).forEach(msg => {
        const role = msg.role === 'user' ? 'User' : 'Jeff';
        prompt += `${role}: ${msg.content}\n`;
      });
      prompt += `\n`;
    }
    
    prompt += `CURRENT USER MESSAGE: ${message}\n\nJeff (respond in JSON format, referencing conversation context if relevant):`;

    // Generate response with retry logic
    let retries = 3;
    let jsonResponse;
    
    while (retries > 0) {
      try {
        const result = await model.generateContent(prompt);
        const response = await result.response;
        let text = response.text();

        // Try to parse JSON response
        try {
          // Remove markdown code blocks if present
          text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
          jsonResponse = JSON.parse(text);
          break; // Success, exit retry loop
        } catch (e) {
          // If JSON parsing fails, create a simple response
          jsonResponse = {
            message: text,
            link: null
          };
          break;
        }
      } catch (error) {
        retries--;
        if (retries === 0) throw error;
        // Wait a bit before retrying
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
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

// Cleanup old rate limit data every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of requestTracker.entries()) {
    const recentRequests = timestamps.filter(t => now - t < RATE_LIMIT.windowMs);
    if (recentRequests.length === 0) {
      requestTracker.delete(ip);
    } else {
      requestTracker.set(ip, recentRequests);
    }
  }
}, 5 * 60 * 1000);

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Jeff backend running on port ${PORT}`);
  console.log(`📝 Test the API: http://localhost:${PORT}/api/health`);
  console.log(`⏱️  Rate limit: ${RATE_LIMIT.maxRequests} requests per minute`);
});


module.exports = app;


