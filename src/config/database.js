const mongoose = require('mongoose')
const { env } = require('./env')

async function connectDatabase() {
  await mongoose.connect(env.MONGODB_URI, {
    dbName: env.MONGODB_DATABASE,
    serverSelectionTimeoutMS: 5000,
  })
  return mongoose.connection
}

async function disconnectDatabase() {
  await mongoose.disconnect()
}

module.exports = { connectDatabase, disconnectDatabase }
