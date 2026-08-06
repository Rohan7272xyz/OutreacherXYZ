// Remembers which creators have already been checked, across restarts, so a
// fresh run doesn't spend its first hour re-visiting profiles it already has.
const fs = require('fs');
const path = require('path');
const { config } = require('../config');

class VisitedStore {
  constructor(platform) {
    this.platform = platform;
    this.file = path.join(config.outputDir, `visited-${platform}.json`);
    this.set = new Set();
    this.dirty = false;
    this.load();
  }

  load() {
    if (!config.persistVisited) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(raw)) raw.forEach((u) => this.set.add(u));
    } catch (err) {
      // No prior run, or an unreadable file — start clean.
    }
  }

  save() {
    if (!config.persistVisited || !this.dirty) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify([...this.set]));
      this.dirty = false;
    } catch (err) {
      // Persistence is best-effort; a failure must not stop the scrape.
    }
  }

  has(username) { return this.set.has(username); }
  get size() { return this.set.size; }

  add(username) {
    this.set.add(username);
    this.dirty = true;
    if (this.set.size % 25 === 0) this.save();
  }

  // Feed saturation fix: forget the recent tail so the feed stops looking
  // "all seen", while keeping the long-term history that prevents re-scraping.
  forgetRecent(count = 300) {
    const entries = [...this.set];
    const keep = entries.slice(0, Math.max(0, entries.length - count));
    this.set = new Set(keep);
    this.dirty = true;
    this.save();
    return entries.length - this.set.size;
  }

  prune() {
    const max = config.maxVisited;
    if (this.set.size <= max) return 0;
    const entries = [...this.set];
    const dropped = entries.length - Math.floor(max / 2);
    this.set = new Set(entries.slice(dropped));
    this.dirty = true;
    this.save();
    return dropped;
  }
}

module.exports = { VisitedStore };
