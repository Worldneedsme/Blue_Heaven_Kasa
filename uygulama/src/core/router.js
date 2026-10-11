'use strict';
// Arayüzden gelen çağrıları servise yönlendirir. Sadece listedeki işlemler çağrılabilir.
const { UserError } = require('./service');

const METHODS = [
  'getState', 'setup', 'addSale', 'addExchange', 'addExpense', 'addOwner', 'addAvans', 'correctAccount', 'moveAccount',
  'closeAccount', 'openAccountsForRoom', 'voidTx', 'closeDay', 'listClosedDays', 'getDayDetail', 'verifyPin', 'lock',
  'report', 'getSettings', 'setRates', 'saveProduct', 'changePin', 'setBackupDir2', 'backupNow', 'restoreBackup', 'resetAll',
];

function makeRouter(svc, log = console.error) {
  return function call(method, arg) {
    if (!METHODS.includes(method)) return { ok: false, error: 'Bilinmeyen işlem.' };
    try {
      return { ok: true, data: svc[method](arg) };
    } catch (e) {
      if (e instanceof UserError) return { ok: false, error: e.message };
      log(e);
      return { ok: false, error: 'Beklenmeyen hata: ' + e.message };
    }
  };
}

module.exports = { makeRouter };
