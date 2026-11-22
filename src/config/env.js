const dotenv = require('dotenv')
const path = require('node:path')
const { z } = require('zod')

dotenv.config()

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  MONGODB_URI: z.string().url(),
  MONGODB_DATABASE: z.string().min(1).default('autohire'),
  ACCESS_TOKEN_SECRET: z.string().min(32).refine(
    (secret) => !secret.startsWith('replace-with-'),
    'Replace the example value with a generated secret',
  ),
  FRONTEND_BASE_URL: z.string().url().default('http://localhost:5173'),
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://127.0.0.1:5173'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SMTP_HOST: z.string().optional().default(''),
  SMTP_PORT: z.preprocess((value) => value === '' || value === undefined ? undefined : value, z.coerce.number().int().min(1).max(65535).optional()),
  SMTP_SECURE: z.enum(['true', 'false']).default('false'),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASSWORD: z.string().optional().default(''),
  MAIL_FROM: z.string().optional().default(''),
  CONTACT_INBOX: z.string().email().default('hello@autohire.ke'),
  PRIVATE_UPLOAD_DIR: z.string().min(1).default(path.resolve(__dirname, '../../private-files')),
  CLOUDINARY_CLOUD_NAME: z.string().optional().default(''),
  CLOUDINARY_API_KEY: z.string().optional().default(''),
  CLOUDINARY_API_SECRET: z.string().optional().default(''),
  PAYHERO_API_BASE_URL: z.string().url().default('https://backend.payhero.co.ke'),
  PAYHERO_USERNAME: z.string().optional().default(''),
  PAYHERO_PASSWORD: z.string().optional().default(''),
  PAYHERO_CHANNEL_ID: z.preprocess(
    (value) => value === '' || value === undefined ? undefined : value,
    z.coerce.number().int().positive().optional(),
  ),
  PAYHERO_CALLBACK_URL: z.preprocess(
    (value) => value === '' || value === undefined ? undefined : value,
    z.string().url().optional().default(''),
  ),
}).superRefine((value, context) => {
  const smtpConfigured = Boolean(value.SMTP_HOST || value.SMTP_PORT || value.SMTP_USER || value.SMTP_PASSWORD || value.MAIL_FROM)
  if (smtpConfigured && (!value.SMTP_HOST || !value.SMTP_PORT || !value.MAIL_FROM)) {
    context.addIssue({ code: 'custom', message: 'SMTP_HOST, SMTP_PORT, and MAIL_FROM are required when SMTP is configured' })
  }
  if (Boolean(value.SMTP_USER) !== Boolean(value.SMTP_PASSWORD)) {
    context.addIssue({ code: 'custom', message: 'SMTP_USER and SMTP_PASSWORD must be configured together' })
  }
  const cloudinaryFields = [value.CLOUDINARY_CLOUD_NAME, value.CLOUDINARY_API_KEY, value.CLOUDINARY_API_SECRET]
  if (cloudinaryFields.some(Boolean) && !cloudinaryFields.every(Boolean)) {
    context.addIssue({ code: 'custom', message: 'CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET must be configured together' })
  }
  const payHeroConfigured = Boolean(
    value.PAYHERO_USERNAME || value.PAYHERO_PASSWORD || value.PAYHERO_CHANNEL_ID || value.PAYHERO_CALLBACK_URL,
  )
  if (payHeroConfigured && (!value.PAYHERO_USERNAME || !value.PAYHERO_PASSWORD
    || !value.PAYHERO_CHANNEL_ID || !value.PAYHERO_CALLBACK_URL)) {
    context.addIssue({ code: 'custom', message: 'PAYHERO_USERNAME, PAYHERO_PASSWORD, PAYHERO_CHANNEL_ID, and PAYHERO_CALLBACK_URL are required together' })
  }
  if (value.PAYHERO_CALLBACK_URL && !value.PAYHERO_CALLBACK_URL.startsWith('https://')) {
    context.addIssue({ code: 'custom', message: 'PAYHERO_CALLBACK_URL must use HTTPS' })
  }
})

const parsed = schema.safeParse(process.env)
if (!parsed.success) {
  const messages = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`)
  throw new Error(`Invalid backend environment:\n${messages.join('\n')}`)
}

const values = parsed.data
const env = Object.freeze({
  ...values,
  PRIVATE_UPLOAD_DIR: path.resolve(values.PRIVATE_UPLOAD_DIR),
  CORS_ORIGINS: values.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),
  SMTP_SECURE: values.SMTP_SECURE.toLowerCase() === 'true',
  smtpConfigured: Boolean(values.SMTP_HOST && values.SMTP_PORT && values.MAIL_FROM),
  cloudinaryConfigured: Boolean(values.CLOUDINARY_CLOUD_NAME && values.CLOUDINARY_API_KEY && values.CLOUDINARY_API_SECRET),
  payHeroConfigured: Boolean(
    values.PAYHERO_USERNAME && values.PAYHERO_PASSWORD && values.PAYHERO_CHANNEL_ID && values.PAYHERO_CALLBACK_URL,
  ),
})

module.exports = { env }
