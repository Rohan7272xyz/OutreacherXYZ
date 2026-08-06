const { execSync } = require('child_process');
const path = require('path');

exports.handler = async (event) => {
  console.log('Pipeline Lambda triggered');
  
  try {
    // Run import-sent
    console.log('Step 1: Import Gmail sent history');
    execSync('node import-sent.js', { 
      cwd: __dirname,
      stdio: 'inherit',
      timeout: 120000 
    });
    
    // Run filter
    console.log('Step 2: Filter Sheet1');
    execSync('node filter.js', { 
      cwd: __dirname,
      stdio: 'inherit',
      timeout: 60000 
    });
    
    return { statusCode: 200, body: 'Pipeline complete' };
  } catch (err) {
    console.error('Pipeline failed:', err.message);
    throw err;
  }
};
