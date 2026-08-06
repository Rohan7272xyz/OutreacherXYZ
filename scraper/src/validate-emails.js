const fs = require('fs');
const dns = require('dns').promises;

const DISPOSABLE_DOMAINS = [
  'mailinator.com', 'guerrillamail.com', 'tempmail.com', '10minutemail.com',
  'throwaway.email', 'temp-mail.org', 'fakeinbox.com', 'yopmail.com'
];

const PERSONAL_DOMAINS = [
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com',
  'aol.com', 'protonmail.com', 'live.com'
];

class EmailValidator {
  constructor() {
    this.dnsCache = new Map();
  }

  isValidSyntax(email) {
    return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email);
  }

  async hasMXRecords(domain) {
    if (this.dnsCache.has(domain)) return this.dnsCache.get(domain);
    try {
      const records = await dns.resolveMx(domain);
      const hasMX = records && records.length > 0;
      this.dnsCache.set(domain, hasMX);
      return hasMX;
    } catch (e) {
      this.dnsCache.set(domain, false);
      return false;
    }
  }

  classifyEmail(email) {
    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain) return 'invalid';
    if (DISPOSABLE_DOMAINS.includes(domain)) return 'disposable';
    if (PERSONAL_DOMAINS.includes(domain)) return 'personal';
    return 'business';
  }

  scoreEmail(email, hasBusinessIndicators = false) {
    let score = 50;
    const classification = this.classifyEmail(email);

    if (classification === 'business') score += 30;
    if (classification === 'personal') score += 10;
    if (classification === 'disposable') score -= 40;
    if (hasBusinessIndicators) score += 15;
    if (email.includes('collab') || email.includes('business')) score += 10;
    if (email.includes('booking') || email.includes('pr@')) score += 10;
    if (/\d{4,}/.test(email)) score -= 10;

    return Math.max(0, Math.min(100, score));
  }

  async validate(email, hasBusinessIndicators = false) {
    const result = { email: email.toLowerCase(), valid: false, classification: 'unknown', score: 0, hasMX: false, issues: [] };

    if (!this.isValidSyntax(email)) {
      result.issues.push('Invalid syntax');
      return result;
    }

    const domain = email.split('@')[1];
    result.hasMX = await this.hasMXRecords(domain);
    if (!result.hasMX) result.issues.push('No MX records');

    result.classification = this.classifyEmail(email);
    if (result.classification === 'disposable') result.issues.push('Disposable domain');

    result.score = this.scoreEmail(email, hasBusinessIndicators);
    result.valid = result.hasMX && result.classification !== 'disposable';

    return result;
  }

  async processResultsFile(inputPath, outputPath) {
    console.log(`Processing: ${inputPath}`);

    const data = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
    const enrichedResults = [];

    for (const creator of data) {
      const enrichedCreator = { ...creator, validatedEmails: [] };

      for (const email of creator.emails) {
        const validation = await this.validate(email, creator.hasBusinessIndicators);
        enrichedCreator.validatedEmails.push(validation);
        console.log(`  ${validation.valid ? 'OK' : 'X'} ${email} (score: ${validation.score})`);
      }

      if (enrichedCreator.validatedEmails.some(v => v.valid)) {
        enrichedResults.push(enrichedCreator);
      }
    }

    enrichedResults.sort((a, b) => {
      const aMax = Math.max(...a.validatedEmails.map(v => v.score));
      const bMax = Math.max(...b.validatedEmails.map(v => v.score));
      return bMax - aMax;
    });

    fs.writeFileSync(outputPath, JSON.stringify(enrichedResults, null, 2));

    const emailsPath = outputPath.replace('.json', '_emails.csv');
    const csvRows = ['email,username,fullName,followers,score,classification'];
    enrichedResults.forEach(c => {
      c.validatedEmails.filter(v => v.valid).forEach(v => {
        csvRows.push(`${v.email},${c.username},"${c.fullName || ''}",${c.followers},${v.score},${v.classification}`);
      });
    });
    fs.writeFileSync(emailsPath, csvRows.join('\n'));

    console.log(`\nDone. Valid creators: ${enrichedResults.length}`);
    console.log(`Output: ${outputPath}`);
    console.log(`Emails: ${emailsPath}`);
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log('Usage: node validate-emails.js <input.json> [output.json]');
    process.exit(1);
  }
  const inputPath = args[0];
  const outputPath = args[1] || inputPath.replace('.json', '_validated.json');
  new EmailValidator().processResultsFile(inputPath, outputPath).catch(console.error);
}

module.exports = { EmailValidator };
