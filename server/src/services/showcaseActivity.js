let lastActivity = Date.now();

function touchActivity() {
  lastActivity = Date.now();
}

function idleMs() {
  return Math.max(0, Date.now() - lastActivity);
}

module.exports = { touchActivity, idleMs };
