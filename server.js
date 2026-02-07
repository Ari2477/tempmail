const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('redis');
const WebSocket = require('ws');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serve static files from public folder

// Available domains for email generation
const DOMAINS = [
    '1secmail.com',
    '1secmail.org',
    '1secmail.net',
    'esiix.com',
    'wwjmp.com',
    'xojxe.com',
    'yoggm.com'
];

// Store active email checkers
const activeCheckers = new Map();

// Email checking interval (5 seconds)
const CHECK_INTERVAL = 5000;

// Helper function to extract OTP
function extractOTP(text) {
    const otpPatterns = [
        /\b\d{4,6}\b/g,                     // 4-6 digit OTP
        /code[:\s]*(\d{4,6})/i,            // Code: 123456
        /otp[:\s]*(\d{4,6})/i,             // OTP: 123456
        /verification[:\s]*(\d{4,6})/i,    // Verification: 123456
        /(\d{4,6})[\s]*is your code/i,     // 123456 is your code
        /your code is[\s]*(\d{4,6})/i      // Your code is 123456
    ];
    
    for (const pattern of otpPatterns) {
        const match = text.match(pattern);
        if (match) {
            // Extract numbers from match
            const numbers = match[0].match(/\d+/);
            if (numbers && numbers[0].length >= 4) {
                return numbers[0];
            }
        }
    }
    return null;
}

// Function to check emails for a specific account
async function checkEmailAccount(email) {
    try {
        const [username, domain] = email.split('@');
        
        // Get messages from 1secmail API
        const response = await axios.get(
            `https://www.1secmail.com/api/v1/?action=getMessages&login=${username}&domain=${domain}`,
            { timeout: 10000 }
        );
        
        if (response.data && Array.isArray(response.data)) {
            const newMessages = [];
            
            // Check each message
            for (const msg of response.data) {
                // Get full message details
                try {
                    const msgResponse = await axios.get(
                        `https://www.1secmail.com/api/v1/?action=readMessage&login=${username}&domain=${domain}&id=${msg.id}`,
                        { timeout: 10000 }
                    );
                    
                    const messageData = {
                        id: msg.id,
                        from: msg.from,
                        subject: msg.subject || 'No Subject',
                        body: msgResponse.data.textBody || msgResponse.data.htmlBody || '',
                        date: msg.date,
                        timestamp: new Date(msg.date).getTime(),
                        otp: null
                    };
                    
                    // Extract OTP from message
                    const fullText = `${messageData.subject} ${messageData.body}`;
                    const otp = extractOTP(fullText);
                    if (otp) {
                        messageData.otp = otp;
                        console.log(`📧 OTP found for ${email}: ${otp}`);
                    }
                    
                    newMessages.push(messageData);
                    
                } catch (msgError) {
                    console.log(`Error fetching message ${msg.id} for ${email}:`, msgError.message);
                }
            }
            
            return newMessages;
        }
        
        return [];
    } catch (error) {
        console.log(`Error checking email ${email}:`, error.message);
        return [];
    }
}

// Start checking emails for an account
function startEmailChecking(email, callback) {
    if (activeCheckers.has(email)) {
        clearInterval(activeCheckers.get(email));
    }
    
    const intervalId = setInterval(async () => {
        try {
            const messages = await checkEmailAccount(email);
            if (messages.length > 0 && callback) {
                callback(email, messages);
            }
        } catch (error) {
            console.log(`Error in checker for ${email}:`, error.message);
        }
    }, CHECK_INTERVAL);
    
    activeCheckers.set(email, intervalId);
    console.log(`Started checking emails for: ${email}`);
}

// Stop checking emails for an account
function stopEmailChecking(email) {
    if (activeCheckers.has(email)) {
        clearInterval(activeCheckers.get(email));
        activeCheckers.delete(email);
        console.log(`Stopped checking emails for: ${email}`);
    }
}

// API ROUTES

// 1. Generate new temporary email
app.post('/api/create-email', async (req, res) => {
    try {
        const { prefix, count = 1 } = req.body;
        
        const generatedEmails = [];
        
        for (let i = 0; i < count; i++) {
            // Generate random username
            const generateUsername = () => {
                const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
                let result = prefix || '';
                const length = 8 - result.length;
                for (let i = 0; i < Math.max(length, 4); i++) {
                    result += chars[Math.floor(Math.random() * chars.length)];
                }
                return result;
            };
            
            const username = generateUsername();
            const domain = DOMAINS[Math.floor(Math.random() * DOMAINS.length)];
            const email = `${username}@${domain}`;
            
            generatedEmails.push(email);
            
            console.log(`Generated email: ${email}`);
        }
        
        res.json({
            success: true,
            emails: generatedEmails,
            message: `Successfully generated ${generatedEmails.length} temporary email(s)`
        });
        
    } catch (error) {
        console.error('Error creating email:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to create email'
        });
    }
});

// 2. Get messages for an email
app.get('/api/get-messages/:email', async (req, res) => {
    try {
        const { email } = req.params;
        
        if (!email || !email.includes('@')) {
            return res.status(400).json({
                success: false,
                error: 'Invalid email address'
            });
        }
        
        const messages = await checkEmailAccount(email);
        
        res.json({
            success: true,
            email,
            messages: messages.reverse(), // Newest first
            count: messages.length,
            timestamp: Date.now()
        });
        
    } catch (error) {
        console.error('Error fetching messages:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch messages'
        });
    }
});

// 3. Check multiple emails at once
app.post('/api/check-emails', async (req, res) => {
    try {
        const { emails } = req.body;
        
        if (!Array.isArray(emails) || emails.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'No emails provided'
            });
        }
        
        const results = [];
        
        // Check each email
        for (const email of emails) {
            try {
                const messages = await checkEmailAccount(email);
                results.push({
                    email,
                    messages: messages.reverse(),
                    count: messages.length,
                    hasOTP: messages.some(msg => msg.otp)
                });
            } catch (emailError) {
                results.push({
                    email,
                    error: emailError.message,
                    messages: [],
                    count: 0
                });
            }
        }
        
        res.json({
            success: true,
            results,
            timestamp: Date.now()
        });
        
    } catch (error) {
        console.error('Error checking emails:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to check emails'
        });
    }
});

// 4. Verify if email is valid
app.get('/api/verify-email/:email', async (req, res) => {
    try {
        const { email } = req.params;
        const [username, domain] = email.split('@');
        
        if (!DOMAINS.includes(domain)) {
            return res.json({
                success: false,
                valid: false,
                message: 'Invalid domain'
            });
        }
        
        // Try to get messages to verify email exists
        const response = await axios.get(
            `https://www.1secmail.com/api/v1/?action=getMessages&login=${username}&domain=${domain}`,
            { timeout: 5000 }
        );
        
        res.json({
            success: true,
            valid: true,
            message: 'Email is valid and active'
        });
        
    } catch (error) {
        res.json({
            success: true,
            valid: false,
            message: 'Email does not exist or is not accessible'
        });
    }
});

// 5. Start real-time checking for an email
app.post('/api/start-realtime', (req, res) => {
    try {
        const { email, clientId } = req.body;
        
        if (!email) {
            return res.status(400).json({
                success: false,
                error: 'Email is required'
            });
        }
        
        // Store client for WebSocket updates (simplified)
        console.log(`Starting real-time checking for ${email}, client: ${clientId}`);
        
        res.json({
            success: true,
            message: 'Real-time checking started'
        });
        
    } catch (error) {
        console.error('Error starting real-time:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to start real-time checking'
        });
    }
});

// 6. Delete/stop checking an email
app.delete('/api/delete-email/:email', (req, res) => {
    try {
        const { email } = req.params;
        
        stopEmailChecking(email);
        
        res.json({
            success: true,
            message: `Stopped checking emails for ${email}`
        });
        
    } catch (error) {
        console.error('Error deleting email:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to delete email'
        });
    }
});

// 7. Dashboard stats
app.get('/api/stats', (req, res) => {
    res.json({
        success: true,
        stats: {
            activeAccounts: activeCheckers.size,
            domainsAvailable: DOMAINS.length,
            checkInterval: CHECK_INTERVAL / 1000 + ' seconds',
            serverTime: new Date().toISOString()
        }
    });
});

// Serve frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
const server = app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌐 Open http://localhost:${PORT} in your browser`);
    console.log(`📧 Using domains: ${DOMAINS.join(', ')}`);
});

// WebSocket for real-time updates
const wss = new WebSocket.Server({ server });

// Store WebSocket connections
const connections = new Map();

wss.on('connection', (ws, req) => {
    const clientId = Date.now() + Math.random().toString(36).substr(2, 9);
    
    console.log(`New WebSocket connection: ${clientId}`);
    
    connections.set(clientId, {
        ws,
        email: null,
        lastActivity: Date.now()
    });
    
    // Send welcome message
    ws.send(JSON.stringify({
        type: 'welcome',
        clientId,
        message: 'Connected to TempMail WebSocket'
    }));
    
    // Handle messages from client
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            switch (data.type) {
                case 'register':
                    connections.get(clientId).email = data.email;
                    console.log(`Client ${clientId} registered for email: ${data.email}`);
                    break;
                    
                case 'ping':
                    ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
                    break;
            }
            
        } catch (error) {
            console.error('Error parsing WebSocket message:', error);
        }
    });
    
    // Handle disconnection
    ws.on('close', () => {
        connections.delete(clientId);
        console.log(`WebSocket disconnected: ${clientId}`);
    });
    
    ws.on('error', (error) => {
        console.error(`WebSocket error for ${clientId}:`, error);
        connections.delete(clientId);
    });
});

// Cleanup inactive connections every hour
setInterval(() => {
    const now = Date.now();
    connections.forEach((conn, clientId) => {
        if (now - conn.lastActivity > 3600000) { // 1 hour
            conn.ws.close();
            connections.delete(clientId);
            console.log(`Cleaned up inactive connection: ${clientId}`);
        }
    });
}, 3600000);

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down server...');
    
    // Clear all intervals
    activeCheckers.forEach((intervalId, email) => {
        clearInterval(intervalId);
    });
    
    // Close WebSocket connections
    wss.close();
    
    server.close(() => {
        console.log('Server stopped');
        process.exit(0);
    });
});
