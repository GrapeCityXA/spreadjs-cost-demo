let cachedFixture;

function normalized(value) {
  return String(value || '').toLowerCase().replace(/[\s\-_（）()]/g, '');
}

function getSyntheticHistoryFixture(environment = process.env.NODE_ENV) {
  if (!['development', 'test'].includes(environment)) return null;
  cachedFixture ||= require('../fixtures/synthetic-monthly-operating-history.json');
  return cachedFixture;
}

function findSyntheticHistoryOrganization(organization, environment = process.env.NODE_ENV) {
  const historyFixture = getSyntheticHistoryFixture(environment);
  if (!historyFixture) return null;
  return historyFixture.organizationScaleFactors.find(item => normalized(item.organizationName) === normalized(organization.name)
    || normalized(item.organizationCode) === normalized(organization.code)) || null;
}

module.exports = { findSyntheticHistoryOrganization, getSyntheticHistoryFixture };
