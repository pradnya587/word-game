const fs = require('fs')

// Read a setting from NAME, or from the file named by NAME_FILE (a mounted/fetched Secret Manager value).
// Secrets therefore never have to be baked into an image or committed to the repository.
function readSecret(name, env = process.env) {
  const file = env[`${name}_FILE`]
  if (file) return fs.readFileSync(file, 'utf8').trim()
  return env[name]
}

module.exports = { readSecret }
