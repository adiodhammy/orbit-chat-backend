import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: 'smtp.ethereal.email',
  port: 587,
  auth: {
    user: 'nicholaus95@ethereal.email',
    pass: '53bHMG6Q3rVkSE2D8P',
  },
});

export const sendVerificationEmail = async (to: string, token: string) => {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:4000';
  const link = `${frontendUrl}/verify?token=${token}`;
  await transporter.sendMail({
    from: 'nicholaus95@ethereal.email',
    to,
    subject: 'Verify your ORBIT\'S CHAT account',
    html: `<h2>Welcome to ORBIT'S CHAT!</h2>
           <p>Please click the link below to verify your email address:</p>
           <a href="${link}">${link}</a>
           <p>This link expires in 24 hours.</p>`,
  });
};

export const sendResetPasswordEmail = async (to: string, token: string) => {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:4000';
  const link = `${frontendUrl}/reset-password?token=${token}`;
  await transporter.sendMail({
    from: 'nicholaus95@ethereal.email',
    to,
    subject: 'Reset your ORBIT\'S CHAT password',
    html: `<h2>Password Reset Request</h2>
           <p>Click the link below to reset your password:</p>
           <a href="${link}">${link}</a>
           <p>This link expires in 1 hour.</p>
           <p>If you didn't request this, ignore this email.</p>`,
  });
};