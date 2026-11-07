'use strict';
(function file() {
  window.TR.files.push(file);
  const TR = window.TR;
  const PREFIX = 'tirYarisi.v1.';

  // Storage can be missing or throw (private windows, blocked site data, file:// in some browsers);
  // the game must still run, it just forgets.
  TR.Store = {
    load(key, fallback) {
      try {
        const raw = window.localStorage.getItem(PREFIX + key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch (e) {
        return fallback;
      }
    },
    save(key, value) {
      try {
        window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
      } catch (e) {
        /* not persisted */
      }
    },
  };

  const DEFAULTS = {
    names: ['Mavi Tır', 'Kırmızı Tır'],
    rounds: 3,
    traffic: 'normal',
    weather: 'gunduz',
    assist: ['hafif', 'hafif'],
    sound: true,
    volume: 0.7,
    navOpen: true,
    shake: true,
    autoPause: true,
    onlineName: 'Oyuncu',
    onlineAssist: 'hafif',
    onlineView: 'tek',
  };
  let settings = Object.assign({}, DEFAULTS, TR.Store.load('settings', {}));

  TR.Settings = {
    get: () => settings,
    set(patch) {
      settings = Object.assign({}, settings, patch);
      TR.Store.save('settings', settings);
      return settings;
    },
  };

  const TOP = 10;
  TR.Scores = {
    rounds: () => TR.Store.load('rounds', []),
    matches: () => TR.Store.load('matches', []),
    // Returns the 0-based place the record took in the top list, or -1 if it did not make it.
    addRound(rec) {
      const list = this.rounds();
      list.push(rec);
      list.sort((a, b) => b.score - a.score || a.date - b.date);
      const kept = list.slice(0, TOP);
      TR.Store.save('rounds', kept);
      return kept.indexOf(rec);
    },
    addMatch(rec) {
      const list = this.matches();
      list.unshift(rec);
      TR.Store.save('matches', list.slice(0, TOP));
    },
    clear() {
      TR.Store.save('rounds', []);
      TR.Store.save('matches', []);
    },
  };
})();
