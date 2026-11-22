const readline = require('node:readline/promises')
const bcrypt = require('bcryptjs')
const { connectDatabase, disconnectDatabase } = require('../config/database')
const { logger } = require('../lib/logger')
const { User } = require('../models')

function ask(question) {
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout })
  return prompt.question(question).finally(() => prompt.close())
}

function askSecret(question) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('Owner password must be entered from an interactive terminal')
  }

  return new Promise((resolve, reject) => {
    const input = process.stdin
    let value = ''
    process.stdout.write(question)
    input.setRawMode(true)
    input.resume()
    input.setEncoding('utf8')

    function finish(error) {
      input.setRawMode(false)
      input.pause()
      input.removeListener('data', onData)
      process.stdout.write('\n')
      if (error) reject(error)
      else resolve(value)
    }

    function onData(character) {
      if (character === '\u0003') return finish(new Error('Owner provisioning cancelled'))
      if (character === '\r' || character === '\n') return finish()
      if (character === '\u007f' || character === '\b') {
        value = value.slice(0, -1)
        return
      }
      value += character
    }

    input.on('data', onData)
  })
}

async function createOwner() {
  await connectDatabase()
  try {
    if (await User.exists({ role: 'owner' })) throw new Error('An owner already exists; bootstrap is only allowed once')

    const name = (await ask('Owner full name: ')).trim()
    const email = (await ask('Owner email: ')).trim().toLowerCase()
    const phone = (await ask('Owner phone (2547XXXXXXXX or 2541XXXXXXXX): ')).trim()
    const password = await askSecret('Owner password (minimum 12 characters): ')
    const confirmation = await askSecret('Confirm owner password: ')

    if (name.length < 2) throw new Error('Owner name must have at least 2 characters')
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid owner email')
    if (!/^254[17]\d{8}$/.test(phone)) throw new Error('Enter a valid Kenyan mobile number')
    if (password.length < 12) throw new Error('Owner password must have at least 12 characters')
    if (password !== confirmation) throw new Error('Passwords do not match')

    const passwordHash = await bcrypt.hash(password, 12)
    await User.create({ name, email, phone, passwordHash, role: 'owner', branch: 'Nairobi HQ', active: true, bootstrapOwner: true })
    logger.info({ email }, 'initial owner provisioned')
  } finally {
    await disconnectDatabase()
  }
}

if (require.main === module) {
  createOwner().catch((error) => {
    logger.error({ err: error }, 'owner provisioning failed')
    process.exitCode = 1
  })
}

module.exports = { createOwner, askSecret }
