const nodemailer = require('nodemailer')
const { AppError } = require('../lib/errors')

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character])
}

function createMailer(env) {
  const transporter = env.smtpConfigured
    ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
    })
    : null

  async function send({ to, subject, text, html, replyTo }) {
    if (!transporter) throw new AppError(503, 'EMAIL_DELIVERY_UNAVAILABLE', 'Email delivery is not configured')
    await transporter.sendMail({ from: env.MAIL_FROM, to, subject, text, html, ...(replyTo ? { replyTo } : {}) })
  }

  return {
    sendInvitation({ to, name, role, link }) {
      const safeName = escapeHtml(name)
      const safeRole = escapeHtml(role)
      return send({
        to,
        subject: 'Your AutoHire KE staff invitation',
        text: `Hello ${name}, you have been invited to join AutoHire KE as ${role}. Accept your invitation: ${link}`,
        html: `<p>Hello ${safeName},</p><p>You have been invited to join AutoHire KE as ${safeRole}.</p><p><a href="${escapeHtml(link)}">Accept your invitation</a></p>`,
      })
    },
    sendPasswordReset({ to, name, link }) {
      const safeName = escapeHtml(name)
      return send({
        to,
        subject: 'Reset your AutoHire KE password',
        text: `Hello ${name}, reset your password within 30 minutes: ${link}`,
        html: `<p>Hello ${safeName},</p><p><a href="${escapeHtml(link)}">Reset your password</a>. This link expires in 30 minutes.</p>`,
      })
    },
    sendContactMessage({ to, name, email, phone, message }) {
      const safeName = escapeHtml(name)
      const safeEmail = escapeHtml(email)
      const safePhone = escapeHtml(phone)
      const safeMessage = escapeHtml(message).replace(/\r?\n/g, '<br>')
      return send({
        to,
        replyTo: email,
        subject: `AutoHire KE contact message from ${name}`,
        text: `Name: ${name}\nEmail: ${email}\nPhone: ${phone}\n\n${message}`,
        html: `<p><strong>Name:</strong> ${safeName}</p><p><strong>Email:</strong> ${safeEmail}</p><p><strong>Phone:</strong> ${safePhone}</p><p>${safeMessage}</p>`,
      })
    },
  }
}

module.exports = { createMailer }
