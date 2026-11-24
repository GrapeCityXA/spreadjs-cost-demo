const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { listTaskAssignees } = require('../src/services/taskAssignees');
const db = new sqlite3.Database(':memory:');
const exec = sql => new Promise((resolve,reject)=>db.exec(sql,error=>error?reject(error):resolve()));
test.after(()=>new Promise(resolve=>db.close(resolve)));
test('picker and write validation share effective role/organization rules',async t=>{
  await exec(`CREATE TABLE users(id INTEGER, name TEXT, username TEXT, account_status TEXT, organization_id INTEGER);
    CREATE TABLE organizations(id INTEGER, organization_type TEXT);
    CREATE TABLE effective_user_roles(user_id INTEGER, role_code TEXT, organization_id INTEGER, effective_from TEXT, effective_to TEXT);
    INSERT INTO organizations VALUES(1,'subsidiary'),(2,'subsidiary'),(3,'department');
    INSERT INTO users VALUES(1,'one','one','active',1),(2,'two','two','active',2),(3,'admin','admin','active',2),
      (4,'disabled','disabled','disabled',1),(5,'expired','expired','active',1),(6,'future','future','active',1),
      (7,'reviewer','reviewer','active',3),(8,'wrongdept','wrongdept','active',2),(9,'plain','plain','active',1);
    INSERT INTO effective_user_roles VALUES(1,'subsidiary_filler',1,'2000-01-01',NULL),(2,'subsidiary_filler',2,'2000-01-01',NULL),
      (3,'system_admin',2,'2000-01-01',NULL),(4,'subsidiary_filler',1,'2000-01-01',NULL),
      (5,'subsidiary_filler',1,'2000-01-01','2001-01-01'),(6,'subsidiary_filler',1,'2999-01-01',NULL),
      (7,'department_reviewer',3,'2000-01-01',NULL),(8,'department_reviewer',3,'2000-01-01',NULL);`);
  await t.test('includes local role and system admin, excludes wrong organization, inactive, expired, future, unqualified',async()=>{
    assert.deepEqual((await listTaskAssignees(db,1,'filler')).map(u=>u.id).sort(),[1,3]);
  });
  await t.test('department reviewers must belong to their department or have explicit target scope',async()=>{
    assert.deepEqual((await listTaskAssignees(db,1,'department_reviewer')).map(u=>u.id).sort(),[3,7]);
  });
  await t.test('write endpoint user restriction gives the same qualification result',async()=>{
    assert.equal((await listTaskAssignees(db,1,'filler',1)).length,1);
    assert.equal((await listTaskAssignees(db,1,'filler',2)).length,0);
    assert.equal((await listTaskAssignees(db,1,'filler',4)).length,0);
  });
  await t.test('unknown responsibilities never return candidates',async()=>assert.deepEqual(await listTaskAssignees(db,1,'admin'),[]));
});
