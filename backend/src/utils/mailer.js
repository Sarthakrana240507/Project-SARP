// Email delivery through SMTP (nodemailer), enabled ONLY when SMTP_HOST and MAIL_FROM are set.
// When it is not configured, nothing is sent and callers are told so honestly (sent: false),
// so the UI never claims an email was delivered.
const nodemailer = require('nodemailer');

let overrideTransport = null; // tests can inject a transport
let cached = null;

function emailEnabled() {
  return Boolean(overrideTransport || (process.env.SMTP_HOST && process.env.MAIL_FROM));
}

function getTransport() {
  if (overrideTransport) return overrideTransport;
  if (!cached) {
    const port = Number(process.env.SMTP_PORT || 587);
    cached = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  }
  return cached;
}

async function sendMail({ to, subject, text }) {
  if (!emailEnabled()) return { sent: false, reason: 'EMAIL_NOT_CONFIGURED' };
  try {
    await getTransport().sendMail({ from: process.env.MAIL_FROM || 'sarp@localhost', to, subject, text });
    return { sent: true };
  } catch (err) {
    // Log only the error message: never the recipient list or the message body (it holds the link).
    console.error('Email delivery failed:', err.message);
    return { sent: false, reason: 'SEND_FAILED' };
  }
}

function activationEmail({ name, link, hours }) {
  return {
    subject: 'Activate your SARP account',
    text: `Hello ${name},\n\nAn account has been created for you on the Student Activity Records Platform (SARP).\n\nOpen this link to verify your email and set your password:\n${link}\n\nThe link can be used once and expires in ${hours} hours. If you did not expect this, ignore this email.\n`,
  };
}
function resetEmail({ name, link, minutes }) {
  return {
    subject: 'Reset your SARP password',
    text: `Hello ${name},\n\nA password reset was requested for your SARP account.\n\nOpen this link to choose a new password:\n${link}\n\nThe link can be used once and expires in ${minutes} minutes. If you did not request this, ignore this email.\n`,
  };
}

function setTransportForTests(t) { overrideTransport = t; }

module.exports = { emailEnabled, sendMail, activationEmail, resetEmail, setTransportForTests };
