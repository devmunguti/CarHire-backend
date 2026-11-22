const { env } = require('./src/config/env')

module.exports = {
  mongodb: {
    url: env.MONGODB_URI,
    databaseName: env.MONGODB_DATABASE,
    options: {},
  },
  migrationsDir: 'migrations',
  changelogCollectionName: 'schema_migrations',
  migrationFileExtension: '.js',
  moduleSystem: 'commonjs',
}
