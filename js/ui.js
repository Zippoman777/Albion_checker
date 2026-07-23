/* ==========================================================================
   ui.js — formatting helpers and a small sortable/filterable table widget.
   ========================================================================== */
(function (AO) {
  'use strict';

  var UI = AO.UI = {};

  /* ------------------------------------------------------------ formatting */

  UI.silver = function (n) {
    if (n == null || !isFinite(n)) return '—';
    var abs = Math.abs(n);
    var s;
    if (abs >= 1e9) s = (n / 1e9).toFixed(2) + 'b';
    else if (abs >= 1e6) s = (n / 1e6).toFixed(2) + 'm';
    else if (abs >= 1e4) s = (n / 1e3).toFixed(1) + 'k';
    else s = Math.round(n).toLocaleString('en-US');
    return s;
  };

  UI.exact = function (n) {
    if (n == null || !isFinite(n)) return '—';
    return Math.round(n).toLocaleString('en-US');
  };

  UI.pct = function (n, digits) {
    if (n == null || !isFinite(n)) return '—';
    return n.toFixed(digits == null ? 1 : digits) + '%';
  };

  UI.age = function (minutes) {
    if (minutes == null || !isFinite(minutes)) return 'unknown';
    if (minutes < 1) return 'just now';
    if (minutes < 60) return Math.round(minutes) + ' min ago';
    var h = minutes / 60;
    if (h < 24) return h.toFixed(1) + ' h ago';
    return (h / 24).toFixed(1) + ' d ago';
  };

  UI.ageBadge = function (minutes) {
    var cls = AO.freshnessClass(minutes);
    var warn = cls === 'fresh-red' ? '⚠ ' : '';
    return '<span class="age ' + cls + '">' + warn + UI.age(minutes) + '</span>';
  };

  UI.profitCell = function (n) {
    var cls = n > 0 ? 'profit-pos' : (n < 0 ? 'profit-neg' : 'profit-zero');
    return '<span class="' + cls + '" title="' + UI.exact(n) + ' silver">' + UI.silver(n) + '</span>';
  };

  UI.icon = function (itemId, size) {
    return '<img class="item-icon" loading="lazy" width="' + (size || 32) + '" height="' +
      (size || 32) + '" src="' + AO.ICON_BASE + encodeURIComponent(itemId) + '.png?size=' +
      (size || 32) + '" alt="" onerror="this.style.visibility=\'hidden\'">';
  };

  UI.escape = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  UI.itemName = function (itemId) {
    var n = AO.itemNames && AO.itemNames[itemId];
    return n || itemId;
  };

  UI.debounce = function (fn, ms) {
    var t;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms == null ? 250 : ms);
    };
  };

  /* ------------------------------------------------------------ DataTable */

  /**
   * @param {HTMLElement} host
   * @param {object} opts
   *   columns: [{ key, label, align, sortValue(row), render(row), tip }]
   *   rows: []
   *   detail(row) -> html for the expanded panel
   *   emptyMessage
   */
  function DataTable(host, opts) {
    this.host = host;
    this.columns = opts.columns;
    this.allRows = opts.rows || [];
    this.detail = opts.detail;
    this.emptyMessage = opts.emptyMessage || 'No rows match the current filters.';
    this.sortKey = opts.defaultSort || null;
    this.sortDir = opts.defaultDir || -1;
    this.filterText = '';
    this.categoryFilter = '';
    // A caller can pass a shared map so expansion survives a full re-render.
    this.expanded = opts.expanded || Object.create(null);
    this.pageSize = opts.pageSize || 100;
    this.page = 0;
    this.render();
  }

  DataTable.prototype.setRows = function (rows) {
    this.allRows = rows || [];
    this.page = 0;
    this.render();
  };

  DataTable.prototype.setFilter = function (text) {
    this.filterText = (text || '').toLowerCase().trim();
    this.page = 0;
    this.render();
  };

  DataTable.prototype.setCategory = function (cat) {
    this.categoryFilter = cat || '';
    this.page = 0;
    this.render();
  };

  DataTable.prototype.visibleRows = function () {
    var self = this;
    var rows = this.allRows.filter(function (r) {
      if (self.categoryFilter && String(r.category || '') !== self.categoryFilter) return false;
      if (!self.filterText) return true;
      var hay = ((r.name || '') + ' ' + (r.itemId || '') + ' ' +
        UI.itemName(r.itemId) + ' ' + (r.craftCity || '') + ' ' +
        (r.sellCity || '')).toLowerCase();
      return hay.indexOf(self.filterText) !== -1;
    });
    if (this.sortKey) {
      var col = this.columns.filter(function (c) { return c.key === self.sortKey; })[0];
      if (col) {
        var val = col.sortValue || function (r) { return r[col.key]; };
        rows.sort(function (a, b) {
          var av = val(a), bv = val(b);
          if (av == null) av = -Infinity;
          if (bv == null) bv = -Infinity;
          if (typeof av === 'string' || typeof bv === 'string') {
            return String(av).localeCompare(String(bv)) * self.sortDir;
          }
          return (av - bv) * self.sortDir;
        });
      }
    }
    return rows;
  };

  DataTable.prototype.render = function () {
    var self = this;
    var rows = this.visibleRows();
    this.filteredCount = rows.length;
    var start = this.page * this.pageSize;
    var pageRows = rows.slice(start, start + this.pageSize);

    if (!rows.length) {
      this.host.innerHTML = '<div class="empty-state">' + UI.escape(this.emptyMessage) + '</div>';
      return;
    }

    var html = '<div class="table-scroll"><table class="data-table"><thead><tr>';
    if (this.detail) html += '<th class="col-expand" aria-label="expand"></th>';
    this.columns.forEach(function (c) {
      var active = self.sortKey === c.key;
      var arrow = active ? (self.sortDir === 1 ? ' ▲' : ' ▼') : '';
      html += '<th class="' + (c.align ? 'align-' + c.align : '') + (active ? ' sorted' : '') +
        '" data-key="' + UI.escape(c.key) + '"' +
        (c.tip ? ' title="' + UI.escape(c.tip) + '"' : '') + '>' +
        UI.escape(c.label) + arrow + '</th>';
    });
    html += '</tr></thead><tbody>';

    pageRows.forEach(function (r, i) {
      var rid = start + i;
      html += '<tr class="data-row" data-idx="' + rid + '">';
      if (self.detail) {
        html += '<td class="col-expand"><button class="expand-btn" aria-expanded="' +
          (self.expanded[rowKey(r)] ? 'true' : 'false') + '">' +
          (self.expanded[rowKey(r)] ? '▾' : '▸') + '</button></td>';
      }
      self.columns.forEach(function (c) {
        html += '<td class="' + (c.align ? 'align-' + c.align : '') + '">' +
          (c.render ? c.render(r) : UI.escape(r[c.key])) + '</td>';
      });
      html += '</tr>';
      if (self.detail && self.expanded[rowKey(r)]) {
        html += '<tr class="detail-row"><td colspan="' + (self.columns.length + 1) + '">' +
          self.detail(r) + '</td></tr>';
      }
    });

    html += '</tbody></table></div>';

    var pages = Math.ceil(rows.length / this.pageSize);
    if (pages > 1) {
      html += '<div class="pager">' +
        '<button class="pg-prev" ' + (this.page === 0 ? 'disabled' : '') + '>← Prev</button>' +
        '<span>Page ' + (this.page + 1) + ' of ' + pages + ' · ' + rows.length + ' rows</span>' +
        '<button class="pg-next" ' + (this.page >= pages - 1 ? 'disabled' : '') + '>Next →</button>' +
        '</div>';
    } else {
      html += '<div class="pager"><span>' + rows.length + ' rows</span></div>';
    }

    this.host.innerHTML = html;
    this.bind(pageRows, start);
  };

  function rowKey(r) {
    return (r.itemId || r.name || '') + '|' + (r.craftCity || r.buyCity || '');
  }

  DataTable.prototype.bind = function (pageRows, start) {
    var self = this;
    Array.prototype.forEach.call(this.host.querySelectorAll('thead th[data-key]'), function (th) {
      th.addEventListener('click', function () {
        var key = th.getAttribute('data-key');
        if (self.sortKey === key) self.sortDir = -self.sortDir;
        else { self.sortKey = key; self.sortDir = -1; }
        self.render();
      });
    });
    Array.prototype.forEach.call(this.host.querySelectorAll('.data-row'), function (tr) {
      var idx = parseInt(tr.getAttribute('data-idx'), 10) - start;
      var row = pageRows[idx];
      if (!row || !self.detail) return;
      tr.addEventListener('click', function (e) {
        // Don't toggle the row when interacting with controls inside it — but
        // the expand button itself must still toggle (it has no own handler).
        if (e.target.closest('a,input,label,select,textarea')) return;
        if (e.target.closest('button:not(.expand-btn)')) return;
        var k = rowKey(row);
        self.expanded[k] = !self.expanded[k];
        self.render();
      });
    });
    var prev = this.host.querySelector('.pg-prev');
    var next = this.host.querySelector('.pg-next');
    if (prev) prev.addEventListener('click', function () { self.page--; self.render(); });
    if (next) next.addEventListener('click', function () { self.page++; self.render(); });
  };

  /** CSV of the currently visible (filtered + sorted) rows. */
  DataTable.prototype.toCsv = function () {
    var self = this;
    var lines = [this.columns.map(function (c) { return csvCell(c.label); }).join(',')];
    this.visibleRows().forEach(function (r) {
      lines.push(self.columns.map(function (c) {
        var v = c.csv ? c.csv(r) : (c.sortValue ? c.sortValue(r) : r[c.key]);
        return csvCell(v);
      }).join(','));
    });
    return lines.join('\n');
  };

  function csvCell(v) {
    if (v == null) return '';
    var s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  UI.DataTable = DataTable;

  /* ------------------------------------------------------------- utilities */

  UI.downloadCsv = function (filename, csv) {
    var blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  };

  UI.copy = function (text, anchorEl) {
    function done(ok) { UI.toast(ok ? 'Copied to clipboard' : 'Copy failed', ok ? 'ok' : 'err'); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { fallback(); });
    } else {
      fallback();
    }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      done(ok);
    }
  };

  UI.toast = function (msg, kind) {
    var host = document.getElementById('toast-host');
    if (!host) return;
    var el = document.createElement('div');
    el.className = 'toast toast-' + (kind || 'ok');
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(function () { el.classList.add('fade'); }, 2200);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 2800);
  };

  UI.skeleton = function (host, rows) {
    var html = '<div class="skeleton-wrap">';
    for (var i = 0; i < (rows || 8); i++) html += '<div class="skeleton-row"></div>';
    html += '</div>';
    host.innerHTML = html;
  };

  UI.errorState = function (host, message, onRetry) {
    host.innerHTML = '<div class="error-state">' +
      '<div class="error-title">⚠ Could not load market data</div>' +
      '<div class="error-msg">' + UI.escape(message) + '</div>' +
      '<button class="btn btn-primary retry-btn">Retry</button></div>';
    var btn = host.querySelector('.retry-btn');
    if (btn && onRetry) btn.addEventListener('click', onRetry);
  };

}(window.AO = window.AO || {}));
