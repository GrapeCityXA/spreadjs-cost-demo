// License keys come only from the process environment. The application no
// longer reads LICENSE.js, so CI can inject secrets without files.

function firstDefined(names) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return undefined;
}

function readLocalSpreadjsLicense() {
  return {
    spreadjsLICENSE: firstDefined(['SPREADJS_LICENSE', 'spreadjsLICENSE']),
    designerLICENSE: firstDefined(['DESIGNER_LICENSE', 'designerLICENSE']),
    serverLICENSE: firstDefined(['SERVER_LICENSE', 'serverLicense'])
  };
}

module.exports = { readLocalSpreadjsLicense };
