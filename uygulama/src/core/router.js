'use strict';
// Arayüzden gelen çağrıları servise yönlendirir. Sadece listedeki işlemler çağrılabilir.
const { UserError } = require('./service');

const METHODS = [
  'getState', 'setup', 'addSale', 'addExchange', 'addExpense', 'addOwner', 'addAvans', 'correctAccount', 'moveAccount',
  'closeAccount', 'payAccount', 'openAccountsForRoom', 'voidTx', 'closeDay', 'listClosedDays', 'getDayDetail', 'verifyPin', 'lock',
  'report', 'getSettings', 'setRates', 'saveProduct', 'changePin', 'setBackupDir2', 'backupNow', 'restoreBackup', 'resetAll', 'exportDay', 'exportMonth', 'listReports', 'lanStatus', 'lanSetEnabled', 'lanNewCode', 'lanRemoveDevice',
];

function makeRouter(svc, log = console.error) {
  return async function call(method, arg) {
    if (!METHODS.includes(method)) return { ok: false, error: 'Bilinmeyen işlem.' };
    try {
      return { ok: true, data: await svc[method](arg) };
    } catch (e) {
      if (e instanceof UserError) return { ok: false, error: e.message };
      log(e);
      return { ok: false, error: 'Beklenmeyen hata: ' + e.message };
    }
  };
}

module.exports = { makeRouter };
