
// ==UserScript==
// @name         Employment Hero - Export CV Reviewed
// @namespace    https://chatgpt.com/
// @version      0.2.2
// @updateURL    https://raw.githubusercontent.com/CanterburyMuseum/employmenthero-candidatelist-export-userscript/main/employmenthero-tampermonkey.user.js
// @downloadURL  https://raw.githubusercontent.com/CanterburyMuseum/employmenthero-candidatelist-export-userscript/main/employmenthero-tampermonkey.user.js
// @description  Export first name, last name and location for all CV Reviewed applicants to CSV.
// @match        https://*.employmenthero.com/*
// @match        https://employmenthero.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const API_ORIGIN = 'https://services.employmenthero.com';
  const API_PATH = '/ats/api/v1/candidate_jobs';
  const ATS_ROUTE = /^\/app\/v2\/organisations\/\d+\/ats\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;
  const STAGE = 'CV Reviewed';
  const REQUESTED_PAGE_SIZE = 1000;
  const MAX_PAGES = 100;
  const ROUTE_CHECK_INTERVAL_MS = 500;

  // Authentication is kept only in this tab's memory. Never log or persist it.
  const state = {
    jobId: null,
    jwt: null,
    stageCount: null,
    exporting: false,
    routePath: null,
    ui: null,
  };
  let lastSeenUrl = location.href;

  const originalFetch = window.fetch;
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const originalXhrSend = XMLHttpRequest.prototype.send;
  const xhrRequests = new WeakMap();

  function parseApiUrl(value) {
    try {
      const url = new URL(String(value), location.href);
      if (url.origin !== API_ORIGIN) return null;
      return url;
    } catch {
      return null;
    }
  }

  function currentRouteJobId() {
    if (location.hostname !== 'secure.employmenthero.com') return null;
    if (new URLSearchParams(location.search).has('candidate_id')) return null;
    return location.pathname.match(ATS_ROUTE)?.[1] ?? null;
  }

  function syncRoute() {
    lastSeenUrl = location.href;
    const routeJobId = currentRouteJobId();
    if (location.pathname !== state.routePath) {
      state.routePath = location.pathname;
      state.jobId = routeJobId;
      state.stageCount = null;
    } else if (routeJobId && !state.jobId) {
      state.jobId = routeJobId;
    }
    updateUi();
  }

  // React/SPA navigation does not reload userscripts or fire popstate on pushState.
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    history[method] = function (...args) {
      const result = original.apply(this, args);
      syncRoute();
      return result;
    };
  }
  window.addEventListener('popstate', syncRoute);
  window.addEventListener('hashchange', syncRoute);
  window.addEventListener('pageshow', syncRoute);
  document.addEventListener('DOMContentLoaded', syncRoute, { once: true });
  if (window.navigation?.addEventListener) {
    window.navigation.addEventListener('currententrychange', syncRoute);
  }

  // Some SPAs replace History API methods after userscripts have hooked them.
  // Comparing the URL is a cheap fallback and also repairs a detached panel.
  setInterval(() => {
    if (location.href !== lastSeenUrl ||
        (document.body && currentRouteJobId() &&
         (!state.ui || !state.ui.panel.isConnected))) {
      syncRoute();
    }
  }, ROUTE_CHECK_INTERVAL_MS);

  function rememberRequest(rawUrl, headers) {
    const url = parseApiUrl(rawUrl);
    if (!url) return;

    // The app may authenticate a different ATS request before loading candidates.
    // Keep the most recent JWT, but use the visible ATS route as the job identity.
    const isCandidateRequest = url.pathname === API_PATH
      || url.pathname === `${API_PATH}/pipeline`;
    const jobId = isCandidateRequest ? url.searchParams.get('job_id') : null;
    if (jobId && currentRouteJobId() && jobId !== state.jobId) {
      state.jobId = jobId;
      state.stageCount = null;
    }

    if (headers) {
      try {
        const token = new Headers(headers).get('jwt-token');
        if (token) state.jwt = token;
      } catch {
        // Ignore unusual header objects used by other libraries.
      }
    }

    syncRoute();
  }

  function rememberPipeline(rawUrl, responseData) {
    const url = parseApiUrl(rawUrl);
    if (!url || url.pathname !== `${API_PATH}/pipeline`) return;
    if (url.searchParams.get('job_id') !== state.jobId) return;
    const phases = responseData?.data?.hiring_phases;
    if (!Array.isArray(phases)) return;
    const phase = phases.find(p => p.name === STAGE);
    if (phase && Number.isFinite(Number(phase.candidates_count))) {
      state.stageCount = Number(phase.candidates_count);
      updateUi();
    }
  }

  // Observe the application's authenticated requests, without changing them.
  window.fetch = function (...args) {
    const input = args[0];
    const options = args[1];
    const requestUrl = typeof input === 'string' || input instanceof URL
      ? String(input)
      : input?.url;

    if (parseApiUrl(requestUrl)) {
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      if (options?.headers) {
        new Headers(options.headers).forEach((value, key) => headers.set(key, value));
      }
      rememberRequest(requestUrl, headers);
    }

    const result = originalFetch.apply(this, args);
    if (parseApiUrl(requestUrl)?.pathname === `${API_PATH}/pipeline`) {
      Promise.resolve(result)
        .then(response => response.clone().json())
        .then(data => rememberPipeline(requestUrl, data))
        .catch(() => {});
    }
    return result;
  };

  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    xhrRequests.set(this, { url: String(url), headers: {} });
    return originalXhrOpen.call(this, method, url, ...args);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    const request = xhrRequests.get(this);
    if (request) request.headers[name] = String(value);
    return originalXhrSetHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    const request = xhrRequests.get(this);
    if (request && parseApiUrl(request.url)) {
      rememberRequest(request.url, request.headers);
      if (parseApiUrl(request.url).pathname === `${API_PATH}/pipeline`) {
        this.addEventListener('load', () => {
          try {
            const data = this.responseType === 'json'
              ? this.response
              : JSON.parse(this.responseText);
            rememberPipeline(request.url, data);
          } catch {
            // The page remains responsible for handling request failures.
          }
        }, { once: true });
      }
    }
    return originalXhrSend.apply(this, args);
  };

  function setStatus(message) {
    if (state.ui) state.ui.status.textContent = message;
  }

  function updateUi() {
    if (!currentRouteJobId()) {
      if (state.ui) state.ui.panel.style.display = 'none';
      return;
    }
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', updateUi, { once: true });
      return;
    }

    if (!state.ui) {
      const panel = document.createElement('div');
      panel.style.cssText = [
        'position:fixed', 'left:16px', 'bottom:16px', 'z-index:2147483647',
        'font:13px/1.4 system-ui,sans-serif', 'background:#fff',
        'color:#1f2937', 'padding:10px', 'border:1px solid #cbd5e1',
        'border-radius:10px', 'box-shadow:0 4px 18px #0002',
        'max-width:275px',
      ].join(';');

      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Export CV Reviewed (CSV)';
      button.style.cssText = [
        'background:#1765d1', 'color:white', 'border:0', 'padding:9px 12px',
        'border-radius:7px', 'font:600 13px system-ui,sans-serif',
        'cursor:pointer', 'width:100%',
      ].join(';');
      button.addEventListener('click', exportCandidates);

      const status = document.createElement('div');
      status.style.cssText = 'margin-top:6px;color:#475569;font-size:12px';
      panel.append(button, status);
      document.body.appendChild(panel);
      state.ui = { panel, button, status };
    } else if (!state.ui.panel.isConnected) {
      document.body.appendChild(state.ui.panel);
    }

    state.ui.panel.style.display = '';
    state.ui.button.disabled = state.exporting || !state.jwt;
    state.ui.button.style.opacity = state.ui.button.disabled ? '0.6' : '1';
    if (!state.exporting) {
      setStatus(state.jwt
        ? `${state.stageCount === null ? 'CV Reviewed candidates' : `${state.stageCount} in CV Reviewed`} · Ready to export`
        : 'Waiting for an authenticated candidate request…');
    }
  }

  function csvCell(value) {
    let text = String(value ?? '');
    // Prevent spreadsheet formula injection from user-supplied candidate fields.
    if (/^[\s]*[=+@\-]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }

  function downloadCsv(rows, jobId) {
    const lines = [
      ['First Name', 'Last Name', 'City/Location'],
      ...rows.map(c => [
        c.applied_first_name ?? '',
        c.applied_last_name ?? '',
        c.vendor_location_name ?? '',
      ]),
    ];
    const csv = '\uFEFF' + lines.map(row => row.map(csvCell).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = `employment-hero-cv-reviewed-${jobId}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
  }

  function numberOrNull(value) {
    return Number.isFinite(Number(value)) && value != null ? Number(value) : null;
  }

  async function fetchAllCandidates(jobId, jwt) {
    const allById = new Map();
    let page = 1;

    while (page <= MAX_PAGES) {
      setStatus(`Retrieving candidates, page ${page}…`);
      const url = new URL(API_PATH, API_ORIGIN);
      url.searchParams.set('job_id', jobId);
      url.searchParams.set('sort', 'first_name');
      url.searchParams.set('item_per_page', String(REQUESTED_PAGE_SIZE));
      url.searchParams.set('page_index', String(page));

      // Send the token only to the same Employment Hero API host.
      const response = await originalFetch.call(window, url.toString(), {
        method: 'GET',
        credentials: 'include',
        headers: { 'jwt-token': jwt, 'Accept': 'application/json' },
      });

      if (response.status === 401 || response.status === 403) {
        throw new Error('Authentication expired. Refresh the Employment Hero tab, wait for the candidate list to load, and try again.');
      }
      if (!response.ok) throw new Error(`Employment Hero returned HTTP ${response.status}.`);

      const json = await response.json();
      const data = json?.data;
      if (!Array.isArray(data?.items)) {
        throw new Error('The candidate list response format has changed (data.items missing).');
      }

      const previousSize = allById.size;
      for (const candidate of data.items) {
        if (candidate?.id) allById.set(candidate.id, candidate);
      }

      const totalItems = numberOrNull(data.total_items ?? data.pagination?.total_items);
      const totalPages = numberOrNull(data.total_pages ?? data.pagination?.total_pages);
      const actualPageSize = numberOrNull(data.item_per_page ?? data.pagination?.item_per_page)
        ?? REQUESTED_PAGE_SIZE;
      const reviewedSoFar = [...allById.values()].filter(
        c => c.hiring_phase?.name === STAGE,
      ).length;

      if (!data.items.length) break;
      if (totalPages !== null && page >= totalPages) break;
      if (totalItems !== null && allById.size >= totalItems) break;
      if (state.stageCount !== null && reviewedSoFar >= state.stageCount) break;
      if (allById.size === previousSize) {
        throw new Error('Pagination returned duplicate records without advancing. Export cancelled.');
      }
      if (totalPages === null && totalItems === null
          && data.items.length < actualPageSize
          && (state.stageCount === null || reviewedSoFar >= state.stageCount)) break;

      page++;
    }

    if (page > MAX_PAGES) throw new Error('Too many pages; export cancelled for safety.');
    return [...allById.values()];
  }

  async function exportCandidates() {
    if (state.exporting || !currentRouteJobId() || !state.jobId || !state.jwt) return;
    state.exporting = true;
    updateUi();

    try {
      const jobId = state.jobId;
      const candidates = await fetchAllCandidates(jobId, state.jwt);
      const collator = new Intl.Collator('en-NZ', { sensitivity: 'base', numeric: true });
      const reviewed = candidates
        .filter(c => c.hiring_phase?.name === STAGE)
        .sort((a, b) => collator.compare(a.applied_first_name ?? '', b.applied_first_name ?? '')
          || collator.compare(a.applied_last_name ?? '', b.applied_last_name ?? ''));

      const missingLocations = reviewed.filter(c => !String(c.vendor_location_name ?? '').trim()).length;
      const warnings = [];
      if (state.stageCount !== null && reviewed.length !== state.stageCount) {
        warnings.push(`The pipeline reports ${state.stageCount} CV Reviewed candidates, but only ${reviewed.length} were retrieved.`);
      }
      if (missingLocations) warnings.push(`${missingLocations} candidate(s) have no city/location in Employment Hero.`);
      if (warnings.length && !window.confirm(`${warnings.join('\n')}\n\nExport anyway?`)) {
        setStatus('Export cancelled; no file downloaded.');
        return;
      }

      downloadCsv(reviewed, jobId);
      setStatus(`Downloaded ${reviewed.length} CV Reviewed candidates (${missingLocations} missing locations).`);
    } catch (error) {
      setStatus(error?.message || 'Unable to export candidates.');
      window.alert(`CV Reviewed export failed:\n${error?.message || error}`);
    } finally {
      state.exporting = false;
      // Keep the outcome message until the next observed Employment Hero request.
      if (state.ui) {
        state.ui.button.disabled = !state.jwt;
        state.ui.button.style.opacity = state.ui.button.disabled ? '0.6' : '1';
      }
    }
  }

  // Apply the initial URL too (including direct loads into an ATS job).
  syncRoute();
})();
