'use strict';
const path = require('path');
const fs = require('fs');
const Mocha = require('mocha');

function run() {
  const mocha = new Mocha({ ui: 'tdd', color: false, timeout: 60000 });
  for (const f of fs.readdirSync(__dirname)) if (f.endsWith('.test.js')) mocha.addFile(path.join(__dirname, f));
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} test(s) failed`)) : resolve()));
  });
}

module.exports = { run };
