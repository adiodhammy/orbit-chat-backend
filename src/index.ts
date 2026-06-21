import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import dotenv from 'dotenv';
import http from 'http';
import { Server as SocketServer } from 'socket.io';
import crypto from 'crypto';
import { sendVerificationEmail, sendResetPasswordEmail } from './services/emailService';

dotenv.config();

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL!,
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const upload = multer({ storage: multer.memoryStorage() });

const prisma = new PrismaClient({ adapter });

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new SocketServer(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// --- WebSocket Connection ---
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  socket.on('register', (userId: string) => {
    socket.join(`user_${userId}`);
    console.log(`User ${userId} joined room user_${userId}`);
  });

  socket.on('send_message', async (data) => {
    console.log('📩 send_message received:', data);
    try {
      const { matchId, senderId, content, imageUrl, audioUrl, replyToId } = data;

      const message = await prisma.message.create({
        data: {
          matchId,
          senderId,
          content: content || null,
          imageUrl: imageUrl || null,
          audioUrl: audioUrl || null,
          replyToId: replyToId || null,
        },
      });

      const match = await prisma.match.findFirst({
        where: { id: matchId },
      });

      if (match) {
        const recipientId = match.user1Id === senderId ? match.user2Id : match.user1Id;

        io.to(`user_${recipientId}`).emit('new_message', {
          message,
          matchId,
          senderId,
        });

        socket.emit('message_sent', message);
      }
    } catch (error) {
      console.error(error);
      socket.emit('error', 'Failed to send message');
    }
  });

  // --- TYPING INDICATOR EVENTS ---
  socket.on('typing_start', ({ matchId, senderId, recipientId }) => {
    io.to(`user_${recipientId}`).emit('user_typing', {
      matchId,
      senderId,
      isTyping: true,
    });
  });

  socket.on('typing_stop', ({ matchId, senderId, recipientId }) => {
    io.to(`user_${recipientId}`).emit('user_typing', {
      matchId,
      senderId,
      isTyping: false,
    });
  });

  // --- MESSAGE REACTIONS ---
  socket.on('add_reaction', async ({ messageId, userId, emoji }) => {
    try {
      const reaction = await prisma.reaction.upsert({
        where: {
          messageId_userId_emoji: {
            messageId,
            userId,
            emoji,
          },
        },
        update: {},
        create: {
          messageId,
          userId,
          emoji,
        },
      });

      const message = await prisma.message.findUnique({
        where: { id: messageId },
        select: { matchId: true },
      });

      if (message) {
        const match = await prisma.match.findFirst({
          where: { id: message.matchId },
        });
        if (match) {
          const recipientId = match.user1Id === userId ? match.user2Id : match.user1Id;
          io.to(`user_${recipientId}`).emit('reaction_added', {
            messageId,
            userId,
            emoji,
          });
          socket.emit('reaction_added', {
            messageId,
            userId,
            emoji,
          });
        }
      }
    } catch (error) {
      console.error(error);
      socket.emit('error', 'Failed to add reaction');
    }
  });

  socket.on('remove_reaction', async ({ messageId, userId, emoji }) => {
    try {
      await prisma.reaction.delete({
        where: {
          messageId_userId_emoji: {
            messageId,
            userId,
            emoji,
          },
        },
      });

      const message = await prisma.message.findUnique({
        where: { id: messageId },
        select: { matchId: true },
      });

      if (message) {
        const match = await prisma.match.findFirst({
          where: { id: message.matchId },
        });
        if (match) {
          const recipientId = match.user1Id === userId ? match.user2Id : match.user1Id;
          io.to(`user_${recipientId}`).emit('reaction_removed', {
            messageId,
            userId,
            emoji,
          });
          socket.emit('reaction_removed', {
            messageId,
            userId,
            emoji,
          });
        }
      }
    } catch (error) {
      console.error(error);
      socket.emit('error', 'Failed to remove reaction');
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// --- HEALTH CHECK ---
app.get('/ping', (req, res) => {
  res.send('pong');
});

// --- REGISTER ---
app.post('/auth/register', async (req, res) => {
  try {
    const { phoneOrEmail, password, name, birthDate, gender } = req.body;

    if (!phoneOrEmail || !password || !name || !birthDate || !gender) {
      return res.status(400).json({
        error: 'Missing required fields: phoneOrEmail, password, name, birthDate, gender',
      });
    }

    const existingUser = await prisma.user.findUnique({
      where: { phoneOrEmail: phoneOrEmail },
    });

    if (existingUser) {
      return res.status(409).json({ error: 'User already exists' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const verificationToken = crypto.randomBytes(32).toString('hex');

    const newUser = await prisma.user.create({
      data: {
        phoneOrEmail,
        passwordHash,
        name,
        birthDate: new Date(birthDate),
        gender,
        verificationToken,
        verifiedAt: new Date(),
      },
    });

    const token = jwt.sign(
      { userId: newUser.id, phoneOrEmail: newUser.phoneOrEmail },
      process.env.JWT_SECRET!,
      { expiresIn: '7d' }
    );

    const { passwordHash: _, ...userWithoutPassword } = newUser;

    res.status(201).json({
      message: 'User registered successfully! 🚀',
      user: userWithoutPassword,
      token,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- VERIFY EMAIL (future use) ---
app.get('/auth/verify', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Missing token' });

    const user = await prisma.user.findFirst({
      where: { verificationToken: token as string },
    });
    if (!user) return res.status(400).json({ error: 'Invalid or expired token' });

    await prisma.user.update({
      where: { id: user.id },
      data: { verifiedAt: new Date(), verificationToken: null },
    });

    res.json({ message: 'Email verified successfully! You can now log in.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// --- REQUEST PASSWORD RESET ---
app.post('/auth/request-reset', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await prisma.user.findUnique({
      where: { phoneOrEmail: email },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const resetToken = crypto.randomBytes(32).toString('hex');
    await prisma.user.update({
      where: { id: user.id },
      data: {
        resetToken,
        resetTokenExpiry: new Date(Date.now() + 3600000),
      },
    });

    res.json({ message: 'Reset link generated (email disabled)' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to send reset email' });
  }
});

// --- RESET PASSWORD ---
app.post('/auth/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) return res.status(400).json({ error: 'Missing fields' });

    const user = await prisma.user.findFirst({
      where: {
        resetToken: token,
        resetTokenExpiry: { gt: new Date() },
      },
    });
    if (!user) return res.status(400).json({ error: 'Invalid or expired token' });

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(newPassword, salt);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, resetToken: null, resetTokenExpiry: null },
    });

    res.json({ message: 'Password reset successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// --- LOGIN ---
app.post('/auth/login', async (req, res) => {
  try {
    const { phoneOrEmail, password } = req.body;

    if (!phoneOrEmail || !password) {
      return res.status(400).json({
        error: 'Missing required fields: phoneOrEmail, password',
      });
    }

    const user = await prisma.user.findUnique({
      where: { phoneOrEmail: phoneOrEmail },
    });

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);

    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { userId: user.id, phoneOrEmail: user.phoneOrEmail },
      process.env.JWT_SECRET!,
      { expiresIn: '7d' }
    );

    const { passwordHash: _, ...userWithoutPassword } = user;

    res.json({
      message: 'Login successful! 🚀',
      user: userWithoutPassword,
      token,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- MIDDLEWARE ---
const verifyToken = (req: any, res: any, next: any) => {
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!);
    req.userId = (decoded as any).userId;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token.' });
  }
};

// --- FEED (with blocked filter) ---
app.get('/feed', verifyToken, async (req: any, res: any) => {
  try {
    const userId = req.userId;
    const limit = parseInt(req.query.limit as string) || 10;

    // Get blocked users
    const blockedUserIds = await prisma.block.findMany({
      where: { blockerId: userId },
      select: { blockedId: true },
    });
    const blockedIds = blockedUserIds.map((b) => b.blockedId);

    const swipedUserIds = await prisma.swipe.findMany({
      where: { swiperId: userId },
      select: { swipedId: true },
    });

    const swipedIds = swipedUserIds.map((s) => s.swipedId);

    const matchedUserIds = await prisma.match.findMany({
      where: {
        OR: [
          { user1Id: userId },
          { user2Id: userId },
        ],
      },
      select: {
        user1Id: true,
        user2Id: true,
      },
    });

    const matchedIds = matchedUserIds.flatMap((m) => {
      const ids = [];
      if (m.user1Id !== userId) ids.push(m.user1Id);
      if (m.user2Id !== userId) ids.push(m.user2Id);
      return ids;
    });

    const excludedIds = [...swipedIds, ...matchedIds, userId, ...blockedIds];

    const potentialMatches = await prisma.user.findMany({
      where: {
        id: { notIn: excludedIds },
      },
      select: {
        id: true,
        name: true,
        photo: true,
        birthDate: true,
        gender: true,
        bio: true,
        isVerified: true,
        createdAt: true,
        occupation: true,
        education: true,
        interests: true,
        isEmailVerified: true,
        isPhoneVerified: true,
        photos: true,
      },
      take: limit,
    });

    res.json({
      users: potentialMatches,
      count: potentialMatches.length,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- SWIPE ---
app.post('/swipe', verifyToken, async (req: any, res: any) => {
  try {
    const swiperId = req.userId;
    const { swipedId, direction } = req.body;

    if (!swipedId || !direction) {
      return res.status(400).json({ error: 'Missing required fields: swipedId, direction' });
    }

    if (!['RIGHT', 'LEFT'].includes(direction)) {
      return res.status(400).json({ error: 'Direction must be "RIGHT" or "LEFT"' });
    }

    if (swiperId === swipedId) {
      return res.status(400).json({ error: 'You cannot swipe on yourself' });
    }

    const targetUser = await prisma.user.findUnique({
      where: { id: swipedId },
    });

    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    const existingSwipe = await prisma.swipe.findUnique({
      where: {
        swiperId_swipedId: {
          swiperId: swiperId,
          swipedId: swipedId,
        },
      },
    });

    if (existingSwipe) {
      return res.status(409).json({ error: 'You have already swiped on this user' });
    }

    const swipe = await prisma.swipe.create({
      data: {
        swiperId: swiperId,
        swipedId: swipedId,
        direction: direction,
      },
    });

    let match = null;
    let isMatch = false;

    if (direction === 'RIGHT') {
      const reciprocalSwipe = await prisma.swipe.findUnique({
        where: {
          swiperId_swipedId: {
            swiperId: swipedId,
            swipedId: swiperId,
          },
        },
      });

      if (reciprocalSwipe && reciprocalSwipe.direction === 'RIGHT') {
        match = await prisma.match.create({
          data: {
            user1Id: swiperId,
            user2Id: swipedId,
            status: 'PENDING',
          },
        });
        isMatch = true;
      }
    }

    res.status(201).json({
      message: 'Swipe recorded successfully',
      swipe: swipe,
      isMatch: isMatch,
      match: match,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- GET MATCHES ---
app.get('/matches', verifyToken, async (req: any, res: any) => {
  try {
    const userId = req.userId;

    const matches = await prisma.match.findMany({
      where: {
        OR: [
          { user1Id: userId },
          { user2Id: userId },
        ],
        status: 'PENDING',
      },
      include: {
        user1: {
          select: {
            id: true,
            name: true,
            photo: true,
            phoneOrEmail: true,
          },
        },
        user2: {
          select: {
            id: true,
            name: true,
            photo: true,
            phoneOrEmail: true,
          },
        },
        messages: {
          orderBy: { sentAt: 'desc' },
          take: 1,
        },
      },
      orderBy: {
        matchedAt: 'desc',
      },
    });

    const formattedMatches = matches.map((match: any) => {
      const otherUser = match.user1Id === userId ? match.user2 : match.user1;
      return {
        matchId: match.id,
        user: otherUser,
        lastMessage: match.messages[0] || null,
        matchedAt: match.matchedAt,
        status: match.status,
      };
    });

    res.json({ matches: formattedMatches });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- GET MESSAGES ---
app.get('/messages/:matchId', verifyToken, async (req: any, res: any) => {
  try {
    const userId = req.userId;
    const { matchId } = req.params;

    const match = await prisma.match.findFirst({
      where: {
        id: matchId,
        OR: [
          { user1Id: userId },
          { user2Id: userId },
        ],
      },
    });

    if (!match) {
      return res.status(404).json({ error: 'Match not found' });
    }

    const messages = await prisma.message.findMany({
      where: { matchId: matchId },
      orderBy: { sentAt: 'asc' },
      select: {
        id: true,
        senderId: true,
        content: true,
        imageUrl: true,
        audioUrl: true,
        sentAt: true,
        isRead: true,
        replyToId: true,
        replyTo: {
          select: {
            id: true,
            content: true,
            senderId: true,
            sentAt: true,
          },
        },
      },
    });

    res.json({ messages });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- SEND MESSAGE (REST) ---
app.post('/messages', verifyToken, async (req: any, res: any) => {
  try {
    const senderId = req.userId;
    const { matchId, content, imageUrl, audioUrl, replyToId } = req.body;

    if (!matchId || (!content && !imageUrl && !audioUrl)) {
      return res.status(400).json({ error: 'Missing matchId, content, imageUrl, or audioUrl' });
    }

    const match = await prisma.match.findFirst({
      where: {
        id: matchId,
        OR: [
          { user1Id: senderId },
          { user2Id: senderId },
        ],
      },
    });

    if (!match) {
      return res.status(404).json({ error: 'Match not found' });
    }

    const message = await prisma.message.create({
      data: {
        matchId: matchId,
        senderId: senderId,
        content: content || null,
        imageUrl: imageUrl || null,
        audioUrl: audioUrl || null,
        replyToId: replyToId || null,
      },
    });

    res.status(201).json({
      message: 'Message sent successfully!',
      data: message,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- UPDATE USER PROFILE (full) ---
app.put('/users/:userId', verifyToken, async (req: any, res: any) => {
  try {
    const userId = req.params.userId;
    const {
      name, bio, photo, interests, height, relationshipGoal,
      interestedIn, occupation, school, education,
      drinking, smoking, exercise, pets,
      communicationStyle, loveLanguage, personalityType,
      idealFirstDate, weekendActivity, zodiacSign,
      photos,
    } = req.body;

    if (userId !== req.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        name, bio, photo, interests, height, relationshipGoal,
        interestedIn, occupation, school, education,
        drinking, smoking, exercise, pets,
        communicationStyle, loveLanguage, personalityType,
        idealFirstDate, weekendActivity, zodiacSign,
        photos,
      },
    });

    const { passwordHash: _, ...userWithoutPassword } = updatedUser;
    res.json({ user: userWithoutPassword });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// --- UPLOAD PROFILE PHOTO (with logging) ---
app.post('/upload', verifyToken, upload.single('photo'), async (req: any, res: any) => {
  try {
    console.log('📸 Upload request received');
    const userId = req.userId;
    if (!req.file) {
      console.log('❌ No file in request');
      return res.status(400).json({ error: 'No file uploaded' });
    }
    console.log(`📸 File size: ${req.file.size} bytes`);

    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'orbit_chat/profiles' },
        (error, result) => {
          if (error) {
            console.error('❌ Cloudinary upload error:', error);
            reject(error);
          } else {
            console.log('✅ Cloudinary upload success');
            resolve(result);
          }
        }
      );
      stream.end(req.file.buffer);
    });

    const photoUrl = (result as any).secure_url;
    console.log(`📸 Photo URL: ${photoUrl}`);

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { photo: photoUrl },
    });

    res.json({
      message: 'Photo uploaded successfully',
      photo: photoUrl,
      user: updatedUser,
    });
  } catch (error) {
    console.error('❌ Upload error:', error);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// --- UPLOAD CHAT IMAGE ---
app.post('/upload/chat', verifyToken, upload.single('image'), async (req: any, res: any) => {
  try {
    const userId = req.userId;
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'orbit_chat/chat_images' },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      stream.end(req.file.buffer);
    });

    const imageUrl = (result as any).secure_url;
    res.json({ imageUrl });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// --- UPLOAD CHAT AUDIO ---
app.post('/upload/chat/audio', verifyToken, upload.single('audio'), async (req: any, res: any) => {
  try {
    const userId = req.userId;
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { 
          folder: 'orbit_chat/chat_audio',
          resource_type: 'auto',
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      stream.end(req.file.buffer);
    });

    const audioUrl = (result as any).secure_url;
    res.json({ audioUrl });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// --- GET USER PROFILE ---
app.get('/users/:userId', verifyToken, async (req: any, res: any) => {
  try {
    const userId = req.params.userId;
    if (userId !== req.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        phoneOrEmail: true,
        name: true,
        bio: true,
        photo: true,
        interests: true,
        height: true,
        relationshipGoal: true,
        birthDate: true,
        gender: true,
        isVerified: true,
        createdAt: true,
        updatedAt: true,
        interestedIn: true,
        occupation: true,
        school: true,
        education: true,
        drinking: true,
        smoking: true,
        exercise: true,
        pets: true,
        communicationStyle: true,
        loveLanguage: true,
        personalityType: true,
        idealFirstDate: true,
        weekendActivity: true,
        zodiacSign: true,
        isEmailVerified: true,
        isPhoneVerified: true,
        photos: true,
        verificationToken: true,
        verifiedAt: true,
        resetToken: true,
        resetTokenExpiry: true,
        latitude: true,
        longitude: true,
        phone: true,
      },
    });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// --- MARK MESSAGES AS READ ---
app.put('/messages/read/:matchId', verifyToken, async (req: any, res: any) => {
  try {
    const userId = req.userId;
    const { matchId } = req.params;

    const match = await prisma.match.findFirst({
      where: {
        id: matchId,
        OR: [
          { user1Id: userId },
          { user2Id: userId },
        ],
      },
    });

    if (!match) {
      return res.status(404).json({ error: 'Match not found' });
    }

    const updatedMessages = await prisma.message.updateMany({
      where: {
        matchId: matchId,
        senderId: { not: userId },
        isRead: false,
      },
      data: {
        isRead: true,
      },
    });

    const otherUserId = match.user1Id === userId ? match.user2Id : match.user1Id;

    io.to(`user_${otherUserId}`).emit('messages_read', {
      matchId: matchId,
      readerId: userId,
      readAt: new Date().toISOString(),
    });

    res.json({
      message: 'Messages marked as read',
      count: updatedMessages.count,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to mark messages as read' });
  }
});

// --- GET PREFERENCES ---
app.get('/preferences', verifyToken, async (req: any, res: any) => {
  try {
    const userId = req.userId;
    const preference = await prisma.preference.findUnique({
      where: { userId },
    });
    if (!preference) {
      return res.status(404).json({ error: 'Preferences not set' });
    }
    res.json({ preference });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch preferences' });
  }
});

// --- SAVE PREFERENCES ---
app.post('/preferences', verifyToken, async (req: any, res: any) => {
  try {
    const userId = req.userId;
    const { minAge, maxAge, maxDistance, preferredGender } = req.body;

    if (minAge == null || maxAge == null || maxDistance == null) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const preference = await prisma.preference.upsert({
      where: { userId },
      update: {
        minAge,
        maxAge,
        maxDistance,
        preferredGender: preferredGender || 'All',
      },
      create: {
        userId,
        minAge,
        maxAge,
        maxDistance,
        preferredGender: preferredGender || 'All',
      },
    });

    res.json({ preference });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to save preferences' });
  }
});

// --- REPORT A USER ---
app.post('/reports', verifyToken, async (req: any, res: any) => {
  try {
    const reporterId = req.userId;
    const { reportedId, reason, description } = req.body;

    if (!reportedId || !reason) {
      return res.status(400).json({ error: 'Missing reportedId or reason' });
    }

    if (reporterId === reportedId) {
      return res.status(400).json({ error: 'You cannot report yourself' });
    }

    const targetUser = await prisma.user.findUnique({
      where: { id: reportedId },
    });
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    const report = await prisma.report.create({
      data: {
        reporterId,
        reportedId,
        reason,
        description,
        status: 'PENDING',
      },
    });

    res.status(201).json({ report });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to report user' });
  }
});

// --- BLOCK A USER ---
app.post('/blocks', verifyToken, async (req: any, res: any) => {
  try {
    const blockerId = req.userId;
    const { blockedId } = req.body;

    if (!blockedId) {
      return res.status(400).json({ error: 'Missing blockedId' });
    }

    if (blockerId === blockedId) {
      return res.status(400).json({ error: 'You cannot block yourself' });
    }

    const targetUser = await prisma.user.findUnique({
      where: { id: blockedId },
    });
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    const block = await prisma.block.upsert({
      where: {
        blockerId_blockedId: {
          blockerId,
          blockedId,
        },
      },
      update: {},
      create: {
        blockerId,
        blockedId,
      },
    });

    res.status(201).json({ block });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to block user' });
  }
});

// --- UNBLOCK A USER ---
app.delete('/blocks/:blockedId', verifyToken, async (req: any, res: any) => {
  try {
    const blockerId = req.userId;
    const { blockedId } = req.params;

    await prisma.block.delete({
      where: {
        blockerId_blockedId: {
          blockerId,
          blockedId,
        },
      },
    });

    res.json({ message: 'User unblocked successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to unblock user' });
  }
});

// --- GET BLOCKED USERS ---
app.get('/blocks', verifyToken, async (req: any, res: any) => {
  try {
    const blockerId = req.userId;

    const blocks = await prisma.block.findMany({
      where: { blockerId },
      include: {
        blocked: {
          select: {
            id: true,
            name: true,
            photo: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const blockedUsers = blocks.map((b) => b.blocked);
    res.json({ blockedUsers });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch blocked users' });
  }
});

// --- COMPATIBILITY SCORE ---
app.get('/compatibility/:userId', verifyToken, async (req: any, res: any) => {
  try {
    const currentUserId = req.userId;
    const targetUserId = req.params.userId;

    if (currentUserId === targetUserId) {
      return res.status(400).json({ error: 'Cannot compare with yourself' });
    }

    // Get both users
    const [currentUser, targetUser] = await Promise.all([
      prisma.user.findUnique({
        where: { id: currentUserId },
        select: {
          interests: true,
          drinking: true,
          smoking: true,
          exercise: true,
          pets: true,
          communicationStyle: true,
          loveLanguage: true,
          personalityType: true,
          relationshipGoal: true,
        },
      }),
      prisma.user.findUnique({
        where: { id: targetUserId },
        select: {
          interests: true,
          drinking: true,
          smoking: true,
          exercise: true,
          pets: true,
          communicationStyle: true,
          loveLanguage: true,
          personalityType: true,
          relationshipGoal: true,
        },
      }),
    ]);

    if (!currentUser || !targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Calculate scores
    const scores = calculateCompatibility(currentUser, targetUser);
    const total = Math.round(
      scores.interests * 0.40 +
      scores.lifestyle * 0.25 +
      scores.personality * 0.20 +
      scores.goals * 0.15
    );

    res.json({
      compatibility: total,
      breakdown: scores,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to calculate compatibility' });
  }
});

// --- HELPER: Calculate Compatibility ---
function calculateCompatibility(user1: any, user2: any) {
  // 1. Interests (40%)
  const interests1 = user1.interests?.split(',').map((i: string) => i.trim().toLowerCase()) || [];
  const interests2 = user2.interests?.split(',').map((i: string) => i.trim().toLowerCase()) || [];
  const commonInterests = interests1.filter((i: string) => interests2.includes(i));
  const interestsScore = interests1.length > 0 || interests2.length > 0
    ? Math.min(100, (commonInterests.length / Math.max(interests1.length, interests2.length)) * 100)
    : 50;

  // 2. Lifestyle (25%)
  let lifestyleMatches = 0;
  let lifestyleTotal = 0;
  const lifestyleFields = ['drinking', 'smoking', 'exercise', 'pets'];
  lifestyleFields.forEach((field) => {
    const val1 = (user1 as any)[field];
    const val2 = (user2 as any)[field];
    if (val1 && val2) {
      lifestyleTotal++;
      if (val1 === val2) lifestyleMatches++;
    }
  });
  const lifestyleScore = lifestyleTotal > 0 ? (lifestyleMatches / lifestyleTotal) * 100 : 50;

  // 3. Personality (20%)
  let personalityMatches = 0;
  let personalityTotal = 0;
  const personalityFields = ['communicationStyle', 'loveLanguage', 'personalityType'];
  personalityFields.forEach((field) => {
    const val1 = (user1 as any)[field];
    const val2 = (user2 as any)[field];
    if (val1 && val2) {
      personalityTotal++;
      if (val1 === val2) personalityMatches++;
    }
  });
  const personalityScore = personalityTotal > 0 ? (personalityMatches / personalityTotal) * 100 : 50;

  // 4. Relationship Goals (15%)
  const goal1 = user1.relationshipGoal;
  const goal2 = user2.relationshipGoal;
  const goalsScore = goal1 && goal2 && goal1 === goal2 ? 100 : 50;

  return {
    interests: Math.round(interestsScore),
    lifestyle: Math.round(lifestyleScore),
    personality: Math.round(personalityScore),
    goals: Math.round(goalsScore),
  };
}

// --- START SERVER ---
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 ORBIT'S CHAT backend is running on http://0.0.0.0:${PORT}`);
  console.log(`🔌 WebSocket server is ready on ws://0.0.0.0:${PORT}`);
});