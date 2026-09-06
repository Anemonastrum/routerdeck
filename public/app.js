import { createApiClient, publicApi } from './js/http.js';
import {
  escapeHtml as esc,
  formatBitsPerSecond as fmtBitsPerSec,
  formatBytes as fmtBytes,
  formatDuration as fmtDuration,
  formatLatency as fmtLatency,
  formatPercent as fmtPct,
  formatUptime as fmtUptime,
} from './js/format.js';
import { heroIcon } from './js/icons.js';
import { setupLogin } from './js/login.js';

const Terminal = window.Terminal;
const FitAddon = window.FitAddon?.FitAddon;

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const state = {
  page: 'dashboard',
  devices: [],
  services: [],
  serviceLive: new Map(),
  serviceUptime: new Map(),
  selected: null,
  selectedService: null,
  serviceTab: 'overview',
  deviceTab: 'overview',
  deviceReturnPage: 'devices',
  serviceReturnPage: 'devices',
  live: new Map(),
  uptime: new Map(),
  terminal: null,
  publicTimer: null,
  clockTimer: null,
  analyticsTimer: null,
  hostAnalytics: null,
  hostAnalyticsAt: 0,
  publicIp: null,
  appSettings: { appName: 'RouterDeck', clockFormat: '24h', theme: 'system', timeZone: 'auto', githubUrl: 'https://github.com/' },
  routerData: { queues: [], queueKind: 'simple', firewall: [], firewallTable: 'filter', logs: [], wireless: [], internetBlocks: [] },
  dashboardEdit: { devices: false, services: false },
  editTarget: null,
  topology: null,
  topologyConnectingFrom: null,
  topologySaving: false,
  topologySaveQueued: false,
  topologySaveTimer: null,
};
const socket = io({ autoConnect: false });

const api = createApiClient({ onUnauthorized: showLogin });

function normalizedTheme(theme = 'system') { return theme === 'light' ? 'latte' : theme === 'dark' ? 'mocha' : theme; }
function resolvedTheme(theme = state.appSettings.theme) {
  const normalized = normalizedTheme(theme);
  if (normalized !== 'system') return normalized;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'latte' : 'mocha';
}
function mikrotikLogoSrc() { return resolvedTheme() === 'latte' ? '/img/mikrotik.svg' : '/img/mikrotik-light.svg'; }
function refreshThemeAwareLogos() {
  document.querySelectorAll('img[data-theme-logo="mikrotik"]').forEach(img => { const src = mikrotikLogoSrc(); if (img.getAttribute('src') !== src) img.setAttribute('src', src); });
}
function applyTheme(theme = 'system') {
  const root = document.documentElement;
  const normalized = normalizedTheme(theme);
  if (['latte', 'frappe', 'macchiato', 'mocha', 'amoled'].includes(normalized)) root.dataset.theme = normalized;
  else delete root.dataset.theme;
  requestAnimationFrame(refreshThemeAwareLogos);
}

function applyAppSettings(settings = {}) {
  state.appSettings = { ...state.appSettings, ...settings };
  applyTheme(state.appSettings.theme);
  const name = state.appSettings.appName || 'RouterDeck';
  const loginName = $('#login-app-name');
  const sidebarName = $('#sidebar-app-name');
  if (loginName) loginName.textContent = name;
  if (sidebarName) sidebarName.textContent = name;
  const appMeta = document.querySelector('meta[name="application-name"]');
  const appleMeta = document.querySelector('meta[name="apple-mobile-web-app-title"]');
  if (appMeta) appMeta.content = name;
  if (appleMeta) appleMeta.content = name;
  const githubLink = $('#login-github');
  if (githubLink) githubLink.href = state.appSettings.githubUrl || 'https://github.com/';
  document.querySelectorAll('.brand-logo').forEach(img => { img.alt = name; });
  if (state.page !== 'device' && location.pathname !== '/status' && location.pathname !== '/status/') document.title = name;
  updateOverviewClock();
}

async function loadPublicBranding() {
  try { applyAppSettings(await publicApi('/api/public/branding')); } catch {}
}

function clockHour12() { return state.appSettings.clockFormat === '12h'; }
function selectedTimeZone() { return state.appSettings.timeZone && state.appSettings.timeZone !== 'auto' ? state.appSettings.timeZone : undefined; }
function dateOptionsWithZone(options = {}) { const timeZone = selectedTimeZone(); return timeZone ? { ...options, timeZone } : options; }
function formatClockTime(date = new Date()) {
  return date.toLocaleTimeString([], dateOptionsWithZone({ hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: clockHour12() })).replace(/:/g, '.');
}
function formatClockDate(date = new Date()) {
  return date.toLocaleDateString([], dateOptionsWithZone({ weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }));
}
function formatDateTime(value) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString([], dateOptionsWithZone({ year:'numeric', month:'short', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:clockHour12() }));
}
function timeZoneOptions(selected = 'auto') {
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local browser time';
  let zones = [];
  try { zones = Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : []; } catch {}
  if (!zones.length) zones = ['UTC','Asia/Jakarta','Asia/Makassar','Asia/Jayapura','Asia/Singapore','Asia/Tokyo','Europe/London','Europe/Amsterdam','America/New_York','America/Los_Angeles','Australia/Sydney'];
  return `<option value="auto" ${selected === 'auto' ? 'selected' : ''}>Automatic (${esc(local)})</option>${zones.map(z => `<option value="${esc(z)}" ${selected === z ? 'selected' : ''}>${esc(z)}</option>`).join('')}`;
}
function updateOverviewClock() {
  const now = new Date();
  const time = $('#overview-clock-time');
  const date = $('#overview-clock-date');
  if (time) time.textContent = formatClockTime(now);
  if (date) date.textContent = formatClockDate(now);
}
function startClock() {
  clearInterval(state.clockTimer);
  updateOverviewClock();
  state.clockTimer = setInterval(updateOverviewClock, 1000);
}

function themeLabel(theme = 'system') {
  return ({ system: 'System · Latte / Mocha', latte: 'Catppuccin Latte', frappe: 'Catppuccin Frappé', macchiato: 'Catppuccin Macchiato', mocha: 'Catppuccin Mocha', amoled: 'AMOLED Black', light: 'Catppuccin Latte', dark: 'Catppuccin Mocha' })[theme] || 'System · Latte / Mocha';
}

window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', () => { if (state.appSettings.theme === 'system') refreshThemeAwareLogos(); });

function osLabel(type) {
  if (type === 'openwrt') return 'OpenWrt';
  if (type === 'mikrotik') return 'MikroTik RouterOS';
  if (type === 'ruijie') return 'Ruijie/Reyee Cloud switch';
  return 'Generic uptime monitor';
}
function osIcon(type, extraClass = '') {
  if (type === 'openwrt') return `<img class="os-logo ${extraClass}" src="/img/openwrt.svg" alt="OpenWrt" />`;
  if (type === 'mikrotik') return `<img class="os-logo mikrotik-theme-logo ${extraClass}" data-theme-logo="mikrotik" src="${mikrotikLogoSrc()}" alt="MikroTik" />`;
  if (type === 'ruijie') return `<img class="os-logo ${extraClass}" src="/img/ruijie.svg" alt="Ruijie/Reyee device" />`;
  return `<img class="os-logo generic-logo router-generic-logo ${extraClass}" src="/img/router.svg" alt="Router / generic network device" />`;
}
function genericRoleLabel(role = 'router') {
  return role === 'access_point' ? 'Access point' : role === 'switch' ? 'Switch' : role === 'ip_camera' ? 'IP camera' : 'Router';
}
function deviceIcon(device, extraClass = '') {
  if (device?.osType !== 'generic') return osIcon(device?.osType, extraClass);
  const role = ['router','access_point','switch','ip_camera'].includes(device.deviceRole) ? device.deviceRole : 'router';
  const src = role === 'access_point' ? '/img/access-point.svg' : role === 'switch' ? '/img/switch.svg' : role === 'ip_camera' ? '/img/ip-camera.svg' : '/img/router.svg';
  return `<img class="os-logo generic-logo generic-${role} ${extraClass}" src="${src}" alt="${genericRoleLabel(role)}" />`;
}

function serviceLabel(type) { return type === 'homeassistant' ? 'Home Assistant' : type === 'proxmox' ? 'Proxmox VE' : type === 'synology' ? 'Synology DSM' : type === 'nginxproxymanager' ? 'Nginx Proxy Manager' : type === 'casaos' ? 'CasaOS' : 'AdGuard Home'; }
function serviceIcon(type = 'adguardhome', extraClass = '') {
  const label = serviceLabel(type);
  const src = type === 'homeassistant' ? '/img/home-assistant.svg' : type === 'proxmox' ? '/img/proxmox.svg' : type === 'synology' ? '/img/synology.svg' : type === 'nginxproxymanager' ? '/img/nginx-proxy-manager.svg' : type === 'casaos' ? '/img/casaos.svg' : '/img/adguard-home.svg';
  return `<img class="os-logo service-logo ${extraClass}" src="${src}" alt="${label}" />`;
}
function serviceWebUrl(service) {
  const scheme = service.scheme || (['proxmox','synology'].includes(service.serviceType) ? 'https' : 'http');
  const port = service.port || (service.serviceType === 'homeassistant' ? 8123 : service.serviceType === 'proxmox' ? 8006 : service.serviceType === 'synology' ? (scheme === 'https' ? 5001 : 5000) : service.serviceType === 'nginxproxymanager' ? 81 : service.serviceType === 'casaos' ? (scheme === 'https' ? 443 : 80) : (scheme === 'https' ? 443 : 80));
  return `${scheme}://${service.host}:${port}`;
}
function brandLogo(extraClass = '') { return `<img class="brand-logo ${extraClass}" src="/img/routerdeck-logo.png" alt="${esc(state.appSettings.appName || 'RouterDeck')}" />`; }
function setContent(html, animate = true) {
  const content = $('#content');
  if (!content) return;
  content.innerHTML = html;
  if (animate) {
    content.classList.remove('content-enter');
    void content.offsetWidth;
    content.classList.add('content-enter');
  }
}

function cleanupAnalyticsTimer() { clearInterval(state.analyticsTimer); state.analyticsTimer = null; }

function cleanupTerminal() {
  const t = state.terminal;
  if (!t) return;
  try { window.removeEventListener('resize', t.resizeHandler); } catch {}
  try { t.socket.disconnect(); } catch {}
  try { t.terminal.dispose(); } catch {}
  state.terminal = null;
}

function showLogin() {
  cleanupTerminal();
  cleanupAnalyticsTimer();
  $('#public-status').classList.add('hidden');
  const app = $('#app');
  const login = $('#login');
  app.classList.add('hidden');
  app.classList.remove('app-auth-enter','app-auth-ready');
  login.classList.remove('login-leaving');
  $('#login-help-panel')?.classList.add('hidden');
  $('#login-help-toggle')?.setAttribute('aria-expanded','false');
  login.classList.remove('hidden');
  requestAnimationFrame(() => login.classList.add('login-ready'));
  const password = $('#login-password');
  if (window.matchMedia?.('(min-width: 761px)').matches) setTimeout(() => password?.focus(), 260);
  socket.disconnect();
}
async function showApp({ fromLogin = false } = {}) {
  $('#public-status').classList.add('hidden');
  const login = $('#login');
  const app = $('#app');
  const loading = Promise.all([
    api('/api/app-settings').catch(() => state.appSettings),
    refreshDevices(),
    refreshServices(),
  ]);
  if (fromLogin) {
    login.classList.add('login-leaving');
    await new Promise(resolve => setTimeout(resolve, 230));
  }
  const [settings] = await loading;
  applyAppSettings(settings);
  login.classList.add('hidden');
  login.classList.remove('login-ready','login-leaving');
  app.classList.remove('hidden');
  if (fromLogin) {
    app.classList.add('app-auth-enter');
    requestAnimationFrame(() => requestAnimationFrame(() => app.classList.add('app-auth-ready')));
    setTimeout(() => app.classList.remove('app-auth-enter','app-auth-ready'), 620);
  }
  socket.connect();
  startClock();
  render(!fromLogin);
}
async function boot() {
  await loadPublicBranding();
  try { await api('/api/me'); await showApp({ fromLogin: false }); }
  catch { showLogin(); }
}

setupLogin({
  authenticate: password => api('/api/login', { method: 'POST', body: JSON.stringify({ password }) }),
  onAuthenticated: () => showApp({ fromLogin: true }),
});

async function logoutFromRouterDeck() {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  showLogin();
}
$('#logout').addEventListener('click', logoutFromRouterDeck);

$$('.nav').forEach(btn => btn.addEventListener('click', () => {
  cleanupTerminal();
  cleanupAnalyticsTimer();
  state.dashboardEdit.devices = false;
  state.dashboardEdit.services = false;
  state.topologyConnectingFrom = null;
  state.page = btn.dataset.page;
  state.selected = null;
  state.selectedService = null;
  state.deviceTab = 'overview';
  state.serviceTab = 'overview';
  $$('.nav').forEach(x => x.classList.toggle('active', x === btn));
  render(true);
}));

async function refreshDevices() {
  state.devices = await api('/api/devices');
  for (const d of state.devices) {
    if (d.metric) state.live.set(d.id, d.metric);
    if (d.uptime) state.uptime.set(d.id, d.uptime);
  }
}

async function refreshServices() {
  state.services = await api('/api/services').catch(() => []);
  for (const service of state.services) {
    if (service.metric) state.serviceLive.set(service.id, service.metric);
    if (service.uptime) state.serviceUptime.set(service.id, service.uptime);
  }
}

function serviceMetricOf(service) { return state.serviceLive.get(service.id) || service.metric || {}; }

socket.on('metric', ({ deviceId, metric }) => {
  state.live.set(deviceId, metric);
  recordTrafficSample(deviceId);
  if (state.selected === deviceId && state.page === 'device') updateOpenDevice(metric);
  if (state.page === 'dashboard') patchDashboardDevice(deviceId);
  else if (state.page === 'devices') patchDeviceListRow(deviceId);
  else if (state.page === 'topology') patchTopologyNode('device', deviceId);
});
socket.on('uptime', u => {
  state.uptime.set(u.deviceId, { status: u.ok ? 1 : 0, latency_ms: u.latencyMs, ts: u.ts });
  if (state.page === 'dashboard') patchDashboardDevice(u.deviceId);
  else if (state.page === 'devices') patchDeviceListRow(u.deviceId);
  else if (state.page === 'uptime') patchUptimeDevice(u.deviceId);
  else if (state.page === 'topology') patchTopologyNode('device', u.deviceId);
});
socket.on('service-metric', ({ serviceId, metric }) => {
  state.serviceLive.set(serviceId, metric);
  if (state.page === 'dashboard') patchDashboardService(serviceId);
  else if (state.page === 'devices') patchServiceListRow(serviceId);
  else if (state.page === 'service' && state.selectedService === serviceId) updateOpenService(metric);

});
socket.on('service-uptime', u => {
  state.serviceUptime.set(u.serviceId, { status: u.ok ? 1 : 0, latency_ms: u.latencyMs, ts: u.ts });
  if (state.page === 'uptime') patchUptimeService(u.serviceId);
  else if (state.page === 'dashboard') patchDashboardService(u.serviceId);
  else if (state.page === 'devices') patchServiceListRow(u.serviceId);
});

function setTitle(title, sub) { $('#page-title').textContent = title; $('#page-subtitle').textContent = sub; document.title = `${title} · ${state.appSettings.appName || 'RouterDeck'}`; }
function statusOf(d) {
  const u = state.uptime.get(d.id);
  return !u ? 'unknown' : Number(u.status) === 1 ? 'up' : 'down';
}
function metricOf(d) { return state.live.get(d.id) || d.metric || {}; }
function deviceModel(d, m = metricOf(d)) { return m?.deviceInfo?.model || m?.deviceInfo?.boardName || d.detectedModel || (d.osType === 'generic' ? `Generic ${genericRoleLabel(d.deviceRole).toLowerCase()}` : 'Detecting model…'); }
function dhcpCount(m) { return m.dhcpCount ?? 0; }
function clientCount(m) { return m.clientsCount ?? m.clients_count ?? m.dhcpCount ?? 0; }
function wifiCount(m) { return m.wifiCount ?? (Array.isArray(m.wifiClients) ? m.wifiClients.length : 0); }
function memoryPercent(m) {
  const direct = Number(m.memoryPercent ?? m.memory_percent);
  if (Number.isFinite(direct)) return direct;
  const total = Number(m.memoryTotal ?? m.memory_total);
  const used = Number(m.memoryUsed ?? m.memory_used);
  return Number.isFinite(total) && total > 0 && Number.isFinite(used) ? (used / total) * 100 : null;
}

function summaryCards() {
  const deviceStates = state.devices.map(d => statusOf(d));
  const serviceStates = state.services.map(s => serviceStatus(s));
  const allStates = [...deviceStates, ...serviceStates];
  const up = allStates.filter(s => s === 'up').length;
  const down = allStates.filter(s => s === 'down').length;
  const total = allStates.length;
  const clients = state.devices.reduce((sum, d) => sum + Number(clientCount(metricOf(d)) || 0), 0);
  const cpus = state.devices.map(d => Number(metricOf(d).cpu)).filter(Number.isFinite);
  const avg = cpus.length ? cpus.reduce((a, b) => a + b, 0) / cpus.length : null;
  return `<div class="cards overview-summary">
    <div class="card clock-card"><div class="stat-label">Local time</div><div class="clock-time" id="overview-clock-time">${formatClockTime()}</div><div class="clock-date" id="overview-clock-date">${esc(formatClockDate())}</div></div>
    <div class="card public-ip-card"><div class="stat-label">Public IP</div><div class="stat-value public-ip-value" data-summary="public-ip">${esc(state.publicIp?.ip || '—')}</div><small class="stat-note" data-summary="public-ip-note">${state.publicIp?.cached ? 'cached result' : 'internet egress'}</small></div>
    <div class="card"><div class="stat-label">Online</div><div class="stat-value" data-summary="online">${up}<small class="stat-note"> / ${total} total${down ? ` · ${down} down` : ''}</small></div></div>
    <div class="card"><div class="stat-label">Connected clients</div><div class="stat-value" data-summary="clients">${clients}</div></div>
    <div class="card"><div class="stat-label">Average CPU</div><div class="stat-value" data-summary="cpu">${fmtPct(avg)}</div></div>
  </div>`;
}

function orderedDashboardDevices() {
  return [...state.devices].sort((a,b) => {
    const ap = a.osType === 'mikrotik' && a.deviceRole === 'host' ? 0 : 1;
    const bp = b.osType === 'mikrotik' && b.deviceRole === 'host' ? 0 : 1;
    return ap - bp || Number(a.displayOrder ?? 0) - Number(b.displayOrder ?? 0) || String(a.name).localeCompare(String(b.name));
  });
}

function deviceCards() {
  if (!state.devices.length) return `<div class="empty">No devices yet. Use <b>Add device</b> to register your first device.</div>`;
  const editing = state.dashboardEdit.devices;
  const ordered = orderedDashboardDevices();
  return `<div class="device-grid dashboard-sort-grid ${editing ? 'order-edit-mode' : ''}" data-order-kind="devices">${ordered.map(d => {
    const m = metricOf(d);
    const u = state.uptime.get(d.id);
    const st = statusOf(d);
    const pinned = d.osType === 'mikrotik' && d.deviceRole === 'host';
    const genericStats = `<div class="mini-stats"><div><b>${st === 'unknown' ? '—' : st === 'up' ? 'Online' : 'Down'}</b><span>Status</span></div><div><b>${fmtLatency(u?.latency_ms)}</b><span>Latency</span></div><div><b>ICMP</b><span>Monitor</span></div></div>`;
    const managedStats = d.osType === 'ruijie' ? `<div class="mini-stats"><div><b>${Array.isArray(m.interfaces)?m.interfaces.filter(p=>p.status==='ready').length:'—'}</b><span>Ports up</span></div><div><b>${m.deviceInfo?.cloudStatus||'—'}</b><span>Cloud</span></div><div><b>${clientCount(m) || '0'}</b><span>Clients</span></div></div>` : `<div class="mini-stats"><div><b>${fmtPct(m.cpu)}</b><span>CPU</span></div><div><b>${fmtPct(memoryPercent(m))}</b><span>Memory</span></div><div><b>${clientCount(m) || '0'}</b><span>Clients</span></div></div>`;
    return `<article class="device-card ${editing ? 'order-card' : ''} ${pinned ? 'order-pinned' : ''}" data-device="${d.id}" ${editing ? `role="group" aria-label="${pinned ? 'Gateway is pinned first' : `Drag ${esc(d.name)} to rearrange`}" title="${pinned ? 'Gateway stays first' : 'Drag card to rearrange'}"` : `tabindex="0" role="button" aria-label="Open ${esc(d.name)}"`}>
      <div class="device-top"><div class="device-identity">${deviceIcon(d)}<div><div class="device-name">${esc(d.name)}</div><div class="device-model">${esc(deviceModel(d, m))}</div><div class="device-host">${esc(d.host)}</div></div></div><span class="device-status-dot ${st}" title="${st === 'up' ? 'Online' : st === 'down' ? 'Down' : 'Unknown'}" aria-label="${st === 'up' ? 'Online' : st === 'down' ? 'Down' : 'Unknown'}"></span></div>
      <div class="device-os-line"><div class="device-os os-${d.osType}">${osLabel(d.osType)}</div>${d.osType === 'mikrotik' ? `<span class="role-pill ${d.deviceRole === 'host' ? 'host' : 'client'}">${d.deviceRole === 'host' ? 'Host' : 'Client'}</span>` : d.osType === 'openwrt' ? `<span class="role-pill client">${d.deviceRole === 'access_point' ? 'Access point' : 'Client'}</span>` : d.osType === 'generic' ? `<span class="role-pill client">${genericRoleLabel(d.deviceRole)}</span>` : ''}</div>
      ${d.osType === 'generic' ? genericStats : managedStats}
    </article>`;
  }).join('')}</div>`;
}

function serviceStatus(service) {
  const u = state.serviceUptime.get(service.id) || service.uptime;
  if (u) return Number(u.status) === 1 ? 'up' : Number(u.status) === 0 ? 'down' : 'unknown';
  const m = serviceMetricOf(service);
  return Number(m.status) === 1 ? 'up' : Number(m.status) === 0 ? 'down' : 'unknown';
}
function serviceMemoryPercent(m) {
  const total = Number(m.memoryTotal ?? m.memory_total);
  const used = Number(m.memoryUsed ?? m.memory_used);
  return Number.isFinite(total) && total > 0 && Number.isFinite(used) ? used / total * 100 : null;
}
function serviceCardStats(service, m, st) {
  if (service.serviceType === 'homeassistant') {
    return `<div class="mini-stats"><div><b>${Number(m.entityCount ?? 0).toLocaleString()}</b><span>Entities</span></div><div><b>${Number(m.roomCount ?? 0).toLocaleString()}</b><span>Rooms</span></div><div><b>${st === 'up' ? 'On' : st === 'down' ? 'Off' : '—'}</b><span>Status</span></div></div>`;
  }
  if (service.serviceType === 'proxmox') {
    return `<div class="mini-stats"><div><b>${fmtPct(m.cpu)}</b><span>CPU</span></div><div><b>${fmtPct(serviceMemoryPercent(m))}</b><span>Memory</span></div><div><b>${Number(m.guestCount ?? 0).toLocaleString()}</b><span>Guests</span></div></div>`;
  }
  if (service.serviceType === 'nginxproxymanager') {
    return `<div class="mini-stats"><div><b>${Number(m.proxyHostCount ?? 0).toLocaleString()}</b><span>Proxy hosts</span></div><div><b>${Number(m.enabledProxyHostCount ?? 0).toLocaleString()}</b><span>Enabled</span></div><div><b>${Number(m.certificateCount ?? 0).toLocaleString()}</b><span>Certificates</span></div></div>`;
  }
  if (service.serviceType === 'synology') {
    return `<div class="mini-stats"><div><b>${fmtPct(m.cpu)}</b><span>CPU</span></div><div><b>${fmtPct(serviceMemoryPercent(m) ?? m.memoryPercent)}</b><span>Memory</span></div><div><b>${Number(m.diskCount ?? 0).toLocaleString()}</b><span>Disks</span></div></div>`;
  }
  if (service.serviceType === 'casaos') {
    return `<div class="mini-stats"><div><b>${Number(m.appCount ?? 0).toLocaleString()}</b><span>Apps</span></div><div><b>${Number(m.runningAppCount ?? 0).toLocaleString()}</b><span>Running</span></div><div><b>${Number(m.updateCount ?? 0).toLocaleString()}</b><span>Updates</span></div></div>`;
  }
  return `<div class="mini-stats"><div><b>${fmtPct(m.cpu)}</b><span>CPU</span></div><div><b>${fmtPct(serviceMemoryPercent(m))}</b><span>Memory</span></div><div><b>${st === 'up' ? 'On' : st === 'down' ? 'Off' : '—'}</b><span>Status</span></div></div>`;
}
function orderedDashboardServices() {
  return [...state.services].sort((a,b) => Number(a.displayOrder ?? 0) - Number(b.displayOrder ?? 0) || String(a.name).localeCompare(String(b.name)));
}
function serviceCards() {
  if (!state.services.length) return `<div class="empty service-empty">No network services yet. Use <b>Add</b> to register AdGuard Home, Home Assistant, Proxmox VE, Synology DSM, Nginx Proxy Manager, or CasaOS.</div>`;
  const editing = state.dashboardEdit.services;
  return `<div class="service-grid dashboard-sort-grid ${editing ? 'order-edit-mode' : ''}" data-order-kind="services">${orderedDashboardServices().map(service => {
    const m = serviceMetricOf(service); const st = serviceStatus(service);
    const protection = m.protectionEnabled ?? (m.protection_enabled == null ? null : Boolean(m.protection_enabled));
    const role = service.serviceType === 'homeassistant'
      ? `<span class="role-pill host">${st === 'up' ? 'API online' : st === 'down' ? 'API offline' : 'Unknown'}</span>`
      : service.serviceType === 'proxmox'
        ? `<span class="role-pill host">${st === 'up' ? `${Number(m.runningCount ?? 0)} running` : st === 'down' ? 'API offline' : 'Unknown'}</span>`
        : service.serviceType === 'synology'
          ? `<span class="role-pill host">${st === 'up' ? (m.health && String(m.health).toLowerCase() !== 'unknown' ? esc(String(m.health)) : 'DSM online') : st === 'down' ? 'DSM offline' : 'Unknown'}</span>`
          : service.serviceType === 'nginxproxymanager'
            ? `<span class="role-pill host">${st === 'up' ? `${Number(m.enabledProxyHostCount ?? 0)} enabled` : st === 'down' ? 'API offline' : 'Unknown'}</span>`
            : service.serviceType === 'casaos'
              ? `<span class="role-pill host">${st === 'up' ? `${Number(m.runningAppCount ?? 0)} running` : st === 'down' ? 'API offline' : 'Unknown'}</span>`
              : `<span class="role-pill ${protection === false ? 'client' : 'host'}">${protection == null ? 'Unknown' : protection ? 'Protection on' : 'Protection off'}</span>`;
    const descriptor = service.serviceType === 'homeassistant' ? 'Home automation service' : service.serviceType === 'proxmox' ? 'Virtualization service' : service.serviceType === 'synology' ? 'NAS / storage service' : service.serviceType === 'nginxproxymanager' ? 'Reverse proxy service' : service.serviceType === 'casaos' ? 'Home server application platform' : 'DNS filtering service';
    return `<article class="service-card ${editing ? 'order-card' : ''}" data-service="${service.id}" ${editing ? `role="group" aria-label="Drag ${esc(service.name)} to rearrange" title="Drag card to rearrange"` : `tabindex="0" role="button" aria-label="Open ${esc(service.name)}"`}>
      <div class="device-top"><div class="device-identity">${serviceIcon(service.serviceType)}<div><div class="device-name">${esc(service.name)}</div><div class="device-model">${serviceLabel(service.serviceType)} ${esc(m.version || '')}</div><div class="device-host">${esc(serviceWebUrl(service).replace(/^https?:\/\//,''))}</div></div></div><span class="device-status-dot ${st}" title="${st === 'up' ? 'Online' : st === 'down' ? 'Offline' : 'Unknown'}"></span></div>
      <div class="device-os-line"><div class="device-os os-service">${descriptor}</div>${role}</div>
      ${serviceCardStats(service,m,st)}
    </article>`;
  }).join('')}</div>`;
}

function serviceListRows() {
  if (!state.services.length) return `<div class="empty service-list-empty">No network services configured.</div>`;
  return state.services.map(service => {
    const m=serviceMetricOf(service); const st=serviceStatus(service);
    const metrics = service.serviceType === 'homeassistant'
      ? `<span><small>Entities</small><b>${Number(m.entityCount ?? 0).toLocaleString()}</b></span><span><small>Rooms</small><b>${Number(m.roomCount ?? 0).toLocaleString()}</b></span><span><small>Status</small><b>${st==='up'?'On':st==='down'?'Off':'—'}</b></span>`
      : service.serviceType === 'proxmox'
        ? `<span><small>CPU</small><b>${fmtPct(m.cpu)}</b></span><span><small>Guests</small><b>${Number(m.guestCount ?? 0).toLocaleString()}</b></span><span><small>Running</small><b>${Number(m.runningCount ?? 0).toLocaleString()}</b></span>`
        : service.serviceType === 'synology'
          ? `<span><small>CPU</small><b>${fmtPct(m.cpu)}</b></span><span><small>Memory</small><b>${fmtPct(serviceMemoryPercent(m) ?? m.memoryPercent)}</b></span><span><small>Disks</small><b>${Number(m.diskCount ?? 0).toLocaleString()}</b></span>`
          : service.serviceType === 'nginxproxymanager'
            ? `<span><small>Proxy hosts</small><b>${Number(m.proxyHostCount ?? 0).toLocaleString()}</b></span><span><small>Enabled</small><b>${Number(m.enabledProxyHostCount ?? 0).toLocaleString()}</b></span><span><small>Certificates</small><b>${Number(m.certificateCount ?? 0).toLocaleString()}</b></span>`
            : service.serviceType === 'casaos'
              ? `<span><small>Apps</small><b>${Number(m.appCount ?? 0).toLocaleString()}</b></span><span><small>Running</small><b>${Number(m.runningAppCount ?? 0).toLocaleString()}</b></span><span><small>Updates</small><b>${Number(m.updateCount ?? 0).toLocaleString()}</b></span>`
              : `<span><small>CPU</small><b>${fmtPct(m.cpu)}</b></span><span><small>Memory</small><b>${fmtPct(serviceMemoryPercent(m))}</b></span><span><small>Status</small><b>${st==='up'?'On':st==='down'?'Off':'—'}</b></span>`;
    return `<article class="device-list-row service-list-row" data-service="${service.id}" tabindex="0" role="button" aria-label="Open ${esc(service.name)}">
      <div class="device-list-identity">${serviceIcon(service.serviceType,'device-list-logo')}<span class="device-status-dot ${st}"></span><div><div class="device-name">${esc(service.name)}</div><div class="device-model">${serviceLabel(service.serviceType)} ${esc(m.version || '')}</div><div class="device-host">${esc(serviceWebUrl(service))}</div></div></div>
      <div class="device-list-platform"><span class="device-os os-service">${serviceLabel(service.serviceType)}</span><small>${service.serviceType === 'synology' ? 'DSM WebAPI managed' : service.serviceType === 'nginxproxymanager' ? 'NPM Web API managed' : service.serviceType === 'casaos' ? 'CasaOS AppManagement API' : 'REST API managed'}</small></div>
      <div class="device-list-metrics">${metrics}</div>
      <button type="button" class="icon-btn inventory-edit" data-edit-service="${service.id}" aria-label="Edit ${esc(service.name)}" title="Edit">${heroIcon('pencil')}</button>
      <span class="device-list-chevron">${heroIcon('chevron')}</span>
    </article>`;
  }).join('');
}

function updateServiceList() {
  const list=$('#service-list'); if(!list) return;
  list.innerHTML=serviceListRows(); bindServiceCards();
}

function markupNode(html) { const t=document.createElement('template'); t.innerHTML=html.trim(); return t.content.firstElementChild; }
function replaceWithSoftUpdate(current, html) { if(!current)return false; const next=markupNode(html); if(!next)return false; if(current.outerHTML===next.outerHTML)return false; current.replaceWith(next); refreshThemeAwareLogos(); return true; }
function patchOverviewSummary() {
  const allStates=[...state.devices.map(d=>statusOf(d)),...state.services.map(s=>serviceStatus(s))];
  const up=allStates.filter(s=>s==='up').length, down=allStates.filter(s=>s==='down').length, total=allStates.length;
  const clients=state.devices.reduce((sum,d)=>sum+Number(clientCount(metricOf(d))||0),0); const cpus=state.devices.map(d=>Number(metricOf(d).cpu)).filter(Number.isFinite); const avg=cpus.length?cpus.reduce((a,b)=>a+b,0)/cpus.length:null;
  const online=$('[data-summary="online"]'); if(online){online.innerHTML=`${up}<small class="stat-note"> / ${total} total${down?` · ${down} down`:''}</small>`;pulseUpdated(online);} patchText('[data-summary="clients"]',clients); patchText('[data-summary="cpu"]',fmtPct(avg));
}
async function loadPublicIp(force = false) {
  try {
    const data = await api(`/api/network/public-ip${force ? '?force=1' : ''}`);
    state.publicIp = data;
    patchText('[data-summary="public-ip"]', data.ip || '—');
    patchText('[data-summary="public-ip-note"]', data.ip ? (data.cached ? 'cached result' : 'internet egress') : (data.error || 'lookup unavailable'));
  } catch (err) {
    if (!state.publicIp) state.publicIp = { ip: null, error: err.message };
    patchText('[data-summary="public-ip"]', state.publicIp.ip || '—');
    patchText('[data-summary="public-ip-note"]', state.publicIp.ip ? 'cached result' : 'lookup unavailable');
  }
}

function singleDeviceCardMarkup(d) { const wrap=markupNode(deviceCards()); return wrap?.querySelector(`[data-device="${d.id}"]`)?.outerHTML || ''; }
function singleServiceCardMarkup(service) { const wrap=markupNode(serviceCards()); return wrap?.querySelector(`[data-service="${service.id}"]`)?.outerHTML || ''; }
function singleDeviceListMarkup(d) { return deviceListRows([d]); }
function singleServiceListMarkup(service) { const all=state.services; state.services=[service]; const html=serviceListRows(); state.services=all; return html; }
function patchDashboardDevice(id) { const d=state.devices.find(x=>x.id===id); if(!d)return; if(state.dashboardEdit.devices){patchOverviewSummary();return;} const el=$(`.device-card[data-device="${id}"]`); if(el){replaceWithSoftUpdate(el,singleDeviceCardMarkup(d));bindDeviceCards();} patchOverviewSummary(); }
function patchDashboardService(id) { const service=state.services.find(x=>x.id===id); if(!service)return; if(state.dashboardEdit.services){patchOverviewSummary();return;} const el=$(`.service-card[data-service="${id}"]`); if(el){replaceWithSoftUpdate(el,singleServiceCardMarkup(service));bindServiceCards();} patchOverviewSummary(); }
function patchDeviceListRow(id) { const d=state.devices.find(x=>x.id===id), el=$(`.device-list-row[data-device="${id}"]`); if(d&&el){replaceWithSoftUpdate(el,singleDeviceListMarkup(d));bindDeviceCards();} }
function patchServiceListRow(id) { const service=state.services.find(x=>x.id===id), el=$(`.service-list-row[data-service="${id}"]`); if(service&&el){replaceWithSoftUpdate(el,singleServiceListMarkup(service));bindServiceCards();} }
function patchUptimeDevice(id){const row=$(`[data-uptime-device="${id}"]`),u=state.uptime.get(id);if(!row||!u)return;const dot=row.querySelector('.status-dot');if(dot)dot.className=`status-dot ${Number(u.status)===1?'up':'down'}`;const latency=row.querySelector('[data-uptime-latency]');if(latency)latency.textContent=`24h • ${fmtLatency(u.latency_ms)}`;pulseUpdated(row);}
function patchUptimeService(id){const row=$(`[data-uptime-service="${id}"]`),u=state.serviceUptime.get(id);if(!row||!u)return;const dot=row.querySelector('.status-dot');if(dot)dot.className=`status-dot ${Number(u.status)===1?'up':'down'}`;const latency=row.querySelector('[data-uptime-latency]');if(latency)latency.textContent=`24h • ${fmtLatency(u.latency_ms)}`;pulseUpdated(row);}
function beginSoftRefresh() { $('#refresh-page')?.classList.add('refreshing'); }
function endSoftRefresh() { $('#refresh-page')?.classList.remove('refreshing'); }

function deviceListRows(devices = state.devices) {
  if (!devices.length) return `<div class="empty device-list-empty">No devices match the current search.</div>`;
  return devices.map(d => {
    const m = metricOf(d);
    const u = state.uptime.get(d.id);
    const st = statusOf(d);
    const statusText = st === 'up' ? 'Online' : st === 'down' ? 'Down' : 'Unknown';
    const metrics = d.osType === 'generic'
      ? `<span><small>Status</small><b>${statusText}</b></span><span><small>Latency</small><b>${fmtLatency(u?.latency_ms)}</b></span>`
      : d.osType === 'ruijie' ? `<span><small>Cloud</small><b>${esc(m.deviceInfo?.cloudStatus||'—')}</b></span><span><small>Ports</small><b>${Array.isArray(m.interfaces)?m.interfaces.length:'—'}</b></span><span><small>Clients</small><b>${clientCount(m) || '0'}</b></span>`
      : `<span><small>CPU</small><b>${fmtPct(m.cpu)}</b></span><span><small>Memory</small><b>${fmtPct(memoryPercent(m))}</b></span><span><small>Clients</small><b>${clientCount(m) || '0'}</b></span>`;
    return `<article class="device-list-row" data-device="${d.id}" tabindex="0" role="button" aria-label="Open ${esc(d.name)}">
      <div class="device-list-identity">${deviceIcon(d, 'device-list-logo')}<span class="device-status-dot ${st}" title="${statusText}" aria-label="${statusText}"></span><div><div class="device-name">${esc(d.name)}</div><div class="device-model">${esc(deviceModel(d, m))}</div><div class="device-host">${esc(d.host)}</div></div></div>
      <div class="device-list-platform"><span class="device-os os-${d.osType}">${osLabel(d.osType)}</span><small>${d.osType === 'generic' ? `ICMP uptime · ${genericRoleLabel(d.deviceRole)}` : d.osType === 'mikrotik' ? `REST managed · ${d.deviceRole === 'host' ? 'host / gateway' : 'client'}` : d.osType === 'ruijie' ? 'Ruijie Cloud · pyruijie' : `SSH / ubus · ${d.deviceRole === 'access_point' ? 'access point' : 'client'}`}</small></div>
      <div class="device-list-metrics">${metrics}</div>
      <button type="button" class="icon-btn inventory-edit" data-edit-device="${d.id}" aria-label="Edit ${esc(d.name)}" title="Edit">${heroIcon('pencil')}</button>
      <span class="device-list-chevron">${heroIcon('chevron')}</span>
    </article>`;
  }).join('');
}

function updateDeviceList() {
  const list = $('#device-list');
  if (!list) return;
  const q = ($('#device-search')?.value || '').trim().toLowerCase();
  const rows = state.devices.filter(d => !q || d.name.toLowerCase().includes(q));
  list.innerHTML = deviceListRows(rows);
  bindDeviceCards();
}

function dashboardEditButton(kind) {
  const active = Boolean(state.dashboardEdit[kind]);
  return `<button type="button" class="ghost button-with-icon dashboard-edit-order ${active ? 'active' : ''}" data-edit-order="${kind}">${heroIcon(active ? 'check' : 'pencil')}<span>${active ? 'Done' : 'Edit'}</span></button>`;
}

function flipGrid(grid, previousRects) {
  requestAnimationFrame(() => {
    [...grid.children].forEach(el => {
      const before = previousRects.get(el);
      if (!before) return;
      const after = el.getBoundingClientRect();
      const dx = before.left - after.left;
      const dy = before.top - after.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      el.animate([
        { transform: `translate(${dx}px, ${dy}px)` },
        { transform: 'translate(0, 0)' },
      ], { duration: 240, easing: 'cubic-bezier(.2,.75,.25,1)' });
    });
  });
}

function applyDashboardOrder(kind, ids) {
  const key = kind === 'devices' ? 'devices' : 'services';
  const source = state[key];
  const byId = new Map(source.map(item => [item.id, item]));
  const ordered = ids.map(id => byId.get(Number(id))).filter(Boolean);
  source.forEach(item => { if (!ordered.includes(item)) ordered.push(item); });
  ordered.forEach((item, index) => { item.displayOrder = index; });
  state[key] = ordered;
}

async function persistDashboardOrder(kind, grid) {
  const attr = kind === 'devices' ? 'device' : 'service';
  const ids = [...grid.children].map(el => Number(el.dataset[attr])).filter(Number.isInteger);
  applyDashboardOrder(kind, ids);
  try {
    const result = await api(`/api/order/${kind}`, { method:'POST', body:JSON.stringify({ ids }) });
    if (Array.isArray(result.ids)) applyDashboardOrder(kind, result.ids);
  } catch (err) {
    console.warn(`Unable to save ${kind} order`, err);
  }
}

function bindSortableDashboardGrid(kind) {
  const grid = $(`.dashboard-sort-grid[data-order-kind="${kind}"]`);
  if (!grid || !state.dashboardEdit[kind]) return;
  const selector = kind === 'devices' ? '.device-card' : '.service-card';

  grid.querySelectorAll(`${selector}.order-card:not(.order-pinned)`).forEach(card => {
    card.onpointerdown = event => {
      if (event.button != null && event.button !== 0) return;
      if (event.target.closest('button,a,input,select,textarea,label')) return;
      event.preventDefault();

      const startRect = card.getBoundingClientRect();
      const pointerId = event.pointerId;
      const offsetX = event.clientX - startRect.left;
      const offsetY = event.clientY - startRect.top;
      const originalStyle = card.getAttribute('style');
      const placeholder = document.createElement('div');
      placeholder.className = 'order-placeholder';
      placeholder.style.height = `${startRect.height}px`;
      placeholder.setAttribute('aria-hidden', 'true');
      grid.insertBefore(placeholder, card);

      card.classList.add('card-dragging');
      grid.classList.add('is-sorting');
      document.body.classList.add('dashboard-card-drag-active');
      document.body.appendChild(card);
      Object.assign(card.style, {
        position: 'fixed',
        left: `${startRect.left}px`,
        top: `${startRect.top}px`,
        width: `${startRect.width}px`,
        height: `${startRect.height}px`,
        margin: '0',
        zIndex: '1000',
        pointerEvents: 'none',
        transform: 'none',
      });

      let moved = false;
      const positionCard = e => {
        card.style.left = `${Math.max(6, Math.min(window.innerWidth - startRect.width - 6, e.clientX - offsetX))}px`;
        card.style.top = `${Math.max(6, Math.min(window.innerHeight - startRect.height - 6, e.clientY - offsetY))}px`;
      };
      positionCard(event);

      const move = e => {
        if (e.pointerId !== pointerId) return;
        e.preventDefault();
        positionCard(e);
        const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest(selector);
        if (!hit || hit.parentElement !== grid) return;

        const previousRects = new Map([...grid.children].map(el => [el, el.getBoundingClientRect()]));
        if (hit.classList.contains('order-pinned')) {
          if (placeholder.previousElementSibling !== hit) grid.insertBefore(placeholder, hit.nextElementSibling);
          else return;
        } else {
          const rect = hit.getBoundingClientRect();
          const sameRow = e.clientY > rect.top + rect.height * .18 && e.clientY < rect.bottom - rect.height * .18;
          const beforeTarget = sameRow ? e.clientX < rect.left + rect.width / 2 : e.clientY < rect.top + rect.height / 2;
          if (beforeTarget) {
            if (placeholder.nextElementSibling === hit) return;
            grid.insertBefore(placeholder, hit);
          } else {
            if (hit.nextElementSibling === placeholder) return;
            grid.insertBefore(placeholder, hit.nextElementSibling);
          }
        }
        flipGrid(grid, previousRects);
        moved = true;
      };

      const finish = async e => {
        if (e.pointerId !== pointerId) return;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
        placeholder.replaceWith(card);
        card.classList.remove('card-dragging');
        grid.classList.remove('is-sorting');
        document.body.classList.remove('dashboard-card-drag-active');
        if (originalStyle == null) card.removeAttribute('style'); else card.setAttribute('style', originalStyle);
        if (moved) await persistDashboardOrder(kind, grid);
      };

      window.addEventListener('pointermove', move, { passive:false });
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', finish);
    };
  });
}

function bindDashboardOrderEditors() {
  $$('[data-edit-order]').forEach(button => button.onclick = () => {
    const kind = button.dataset.editOrder;
    if (!['devices','services'].includes(kind)) return;
    state.dashboardEdit[kind] = !state.dashboardEdit[kind];
    if (state.dashboardEdit[kind]) state.dashboardEdit[kind === 'devices' ? 'services' : 'devices'] = false;
    renderDashboard(false);
  });
  bindSortableDashboardGrid('devices');
  bindSortableDashboardGrid('services');
}

function renderDashboard(animate = true) {
  setTitle('Overview', 'Live health across your network');
  const host = state.devices.find(d => d.osType === 'mikrotik' && d.deviceRole === 'host');
  setContent(summaryCards() +
    `<div class="section-head dashboard-section-head"><div><h2>Network devices</h2><p>Current status and resource use</p></div>${dashboardEditButton('devices')}</div>` + deviceCards() +
    `<div class="section-head service-section-head dashboard-section-head"><div><h2>Network services</h2><p>DNS, home automation, virtualization, storage and home-server apps managed by RouterDeck</p></div>${dashboardEditButton('services')}</div>` + serviceCards() + trafficSectionHTML() +
    (host ? `<div id="dashboard-connection-analytics" class="connection-analytics-slot dashboard-analytics">${state.hostAnalytics ? renderConnectionAnalytics(state.hostAnalytics) : analyticsSkeleton()}</div>` : ''), animate);
  bindDeviceCards(); bindServiceCards(); bindDashboardOrderEditors();
  recordTrafficSample(host?.id);
  bindTrafficPicker();
  updateOverviewClock();
  loadPublicIp(false);
  cleanupAnalyticsTimer();
  if (host) { if(!state.hostAnalytics || Date.now()-state.hostAnalyticsAt>12000) loadDashboardHostAnalytics(host,Boolean(state.hostAnalytics)); state.analyticsTimer=setInterval(()=>loadDashboardHostAnalytics(host,true),15000); }
  else { state.hostAnalytics=null; state.hostAnalyticsAt=0; }
}
function renderDevices(animate = true) {
  setTitle('Devices', 'Manage your network devices');
  setContent(`<div class="section-head device-section-head"><div><h2>Device inventory</h2><p>Search monitored devices.</p></div><button type="button" class="primary button-with-icon" id="add-inline">${heroIcon('plus')}<span>Add</span></button></div>
    <div class="device-toolbar">
      <label class="device-search">${heroIcon('search')}<input id="device-search" type="search" autocomplete="off" placeholder="Search device name…" aria-label="Search device name" /></label>
    </div>
    <div id="device-list" class="device-list">${deviceListRows()}</div>
    <div class="section-head device-section-head network-services-inventory"><div><h2>Network services</h2><p>AdGuard Home, Home Assistant, Proxmox VE, Synology DSM, Nginx Proxy Manager and CasaOS managed alongside your devices.</p></div></div>
    <div id="service-list" class="device-list service-list">${serviceListRows()}</div>`, animate);
  $('#add-inline')?.addEventListener('click', () => openDialog('device'));
  $('#device-search')?.addEventListener('input', updateDeviceList);
  updateDeviceList(); updateServiceList();
}

const TOPOLOGY_CARD_WIDTH = 260;
const TOPOLOGY_CARD_HEIGHT = 72;

function topologyEntity(node) {
  const device = state.devices.find(item => item.id === node.entityId);
  if (!device) return null;
  const role = device.osType === 'mikrotik' && device.deviceRole === 'host'
    ? 'Gateway'
    : device.osType === 'openwrt'
      ? (device.deviceRole === 'access_point' ? 'Access point' : 'Client')
      : device.osType === 'generic'
        ? genericRoleLabel(device.deviceRole)
        : device.osType === 'ruijie' ? 'Switch' : 'Client';
  return {
    type: 'device',
    name: device.name,
    host: device.host,
    label: `${osLabel(device.osType)} · ${role}`,
    status: statusOf(device),
    icon: deviceIcon(device, 'topology-node-logo'),
    source: device,
  };
}

function topologyDeviceShowsClients(device) {
  if (!device) return false;
  if (device.osType === 'mikrotik' && device.deviceRole === 'host') return false;
  return device.deviceRole === 'access_point' || device.deviceRole === 'client' || device.osType === 'ruijie';
}

function topologyAttachedClientGroups() {
  if (!state.topology) return [];
  const result = [];
  for (const node of state.topology.nodes) {
    const entity = topologyEntity(node);
    if (!entity || !topologyDeviceShowsClients(entity.source)) continue;
    const allClients = normalizedClientCandidates(metricOf(entity.source));
    if (!allClients.length) continue;
    const clients = allClients.slice(0, 5);
    result.push({
      parentNodeId: node.id,
      x: Number(node.x || 0) + TOPOLOGY_CARD_WIDTH + 76,
      y: Number(node.y || 0),
      height: 48 + clients.length * 28 + (allClients.length > clients.length ? 22 : 0),
      clients,
      extraCount: Math.max(0, allClients.length - clients.length),
    });
  }
  return result;
}

function topologyCanvasSize() {
  const nodes = state.topology?.nodes || [];
  const groups = topologyAttachedClientGroups();
  const width = Math.max(1040, ...nodes.map(node => Number(node.x || 0) + TOPOLOGY_CARD_WIDTH + 90), ...groups.map(item => item.x + 250));
  const height = Math.max(620, ...nodes.map(node => Number(node.y || 0) + TOPOLOGY_CARD_HEIGHT + 90), ...groups.map(item => item.y + item.height + 70));
  return { width, height };
}

function topologyNodeCenter(node, towardNode = null) {
  const y = Number(node.y || 0) + TOPOLOGY_CARD_HEIGHT / 2;
  const x = Number(node.x || 0);
  if (!towardNode) return { x: x + TOPOLOGY_CARD_WIDTH / 2, y };
  const towardX = Number(towardNode.x || 0) + TOPOLOGY_CARD_WIDTH / 2;
  const centerX = x + TOPOLOGY_CARD_WIDTH / 2;
  return { x: towardX >= centerX ? x + TOPOLOGY_CARD_WIDTH : x, y };
}

function topologyLinkPath(link) {
  const nodes = state.topology?.nodes || [];
  const source = nodes.find(node => node.id === link.sourceNodeId);
  const target = nodes.find(node => node.id === link.targetNodeId);
  if (!source || !target) return '';
  const a = topologyNodeCenter(source, target);
  const b = topologyNodeCenter(target, source);
  const distance = Math.max(70, Math.abs(b.x - a.x) * .48);
  const direction = b.x >= a.x ? 1 : -1;
  return `M ${a.x} ${a.y} C ${a.x + distance * direction} ${a.y}, ${b.x - distance * direction} ${b.y}, ${b.x} ${b.y}`;
}

function topologyLinksMarkup() {
  const links = state.topology?.links || [];
  return links.map(link => {
    const path = topologyLinkPath(link);
    return path ? `<path class="topology-link-path" data-topology-link-path="${link.id || ''}" d="${path}"/>` : '';
  }).join('');
}

function topologyClientLinksMarkup() {
  const nodes = state.topology?.nodes || [];
  return topologyAttachedClientGroups().map(group => {
    const parent = nodes.find(node => node.id === group.parentNodeId);
    if (!parent) return '';
    const x1 = Number(parent.x || 0) + TOPOLOGY_CARD_WIDTH;
    const y1 = Number(parent.y || 0) + TOPOLOGY_CARD_HEIGHT / 2;
    const x2 = group.x;
    const y2 = group.y + Math.min(group.height / 2, 58);
    const bend = Math.max(32, (x2 - x1) * .55);
    return `<path class="topology-client-link" d="M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}"/>`;
  }).join('');
}

function topologyClientCardsMarkup() {
  return topologyAttachedClientGroups().map(group => {
    const rows = group.clients.map(client => `<div class="topology-client-row"><span class="topology-client-row-icon">${heroIcon('client')}</span><span><strong>${esc(client.hostname || 'Connected device')}</strong><small>${esc(client.address || client.mac || 'Unknown address')}</small></span><em>${esc(client.source || 'Client')}</em></div>`).join('');
    return '';
  }).join('');
}

function topologyNodeMarkup(node) {
  const entity = topologyEntity(node);
  if (!entity) return '';
  const active = Number(state.topologyConnectingFrom) === Number(node.id);
  const statusText = entity.status === 'up' ? 'Online' : entity.status === 'down' ? 'Down' : 'Unknown';
  return `<article class="topology-node ${active ? 'is-connecting' : ''}" data-topology-node="${node.id}" data-entity-type="device" data-entity-id="${node.entityId}" style="left:${Number(node.x || 0)}px;top:${Number(node.y || 0)}px" aria-label="${esc(entity.name)} topology node">
    <div class="topology-node-main">
      <div class="topology-node-icon">${entity.icon}<span class="device-status-dot ${entity.status}" title="${statusText}"></span></div>
      <div class="topology-node-copy"><strong>${esc(entity.name)}</strong><span>${esc(entity.label)}</span><small>${esc(entity.host)}</small></div>
      <div class="topology-node-actions">
        <button type="button" class="icon-btn topology-connect ${active ? 'active' : ''}" data-topology-connect="${node.id}" aria-pressed="${active ? 'true' : 'false'}" aria-label="${active ? 'Cancel connection from' : 'Connect from'} ${esc(entity.name)}" title="${active ? 'Cancel connection' : 'Connect device'}">${heroIcon('chevronDoubleRight')}</button>
      </div>
    </div>
  </article>`;
}

function topologyConnectionRows() {
  const links = state.topology?.links || [];
  if (!links.length) return '<div class="topology-empty-links">No saved device connections yet. Select the double-chevron on one card, then select it on another device.</div>';
  const nodes = state.topology?.nodes || [];
  return `<div class="topology-connection-list">${links.map((link, index) => {
    const source = nodes.find(node => node.id === link.sourceNodeId);
    const target = nodes.find(node => node.id === link.targetNodeId);
    const a = source ? topologyEntity(source) : null;
    const b = target ? topologyEntity(target) : null;
    if (!a || !b) return '';
    return `<div class="topology-connection-row"><span class="status-dot ${a.status}"></span><b>${esc(a.name)}</b><span class="topology-connection-arrow">↔</span><span class="status-dot ${b.status}"></span><b>${esc(b.name)}</b><button type="button" class="icon-btn topology-remove-link" data-topology-remove-link="${index}" aria-label="Remove connection between ${esc(a.name)} and ${esc(b.name)}" title="Remove connection">${heroIcon('trash')}</button></div>`;
  }).join('')}</div>`;
}

function topologyPageMarkup() {
  const topology = state.topology || { nodes: [], links: [] };
  if (!topology.nodes.length) return `<div class="empty">Add a network device first, then return to Topology.</div>`;
  const { width, height } = topologyCanvasSize();
  const connecting = topology.nodes.find(node => node.id === state.topologyConnectingFrom);
  const connectingEntity = connecting ? topologyEntity(connecting) : null;
  return `<div class="topology-toolbar card">
      <div><strong>Network map</strong><span id="topology-save-state">Drag cards to arrange them. Changes save automatically.</span></div>
      <div class="topology-toolbar-actions"><button type="button" class="ghost button-with-icon" id="topology-auto-arrange">${heroIcon('sparkles')}<span>Auto arrange</span></button><button type="button" class="ghost button-with-icon" id="topology-clear-links" ${topology.links.length ? '' : 'disabled'}>${heroIcon('trash')}<span>Clear links</span></button></div>
    </div>
    <div class="topology-help ${connectingEntity ? 'connecting' : ''}" id="topology-help">${connectingEntity ? `Connecting from <b>${esc(connectingEntity.name)}</b>. Choose the double-chevron on the destination card, or select the same card to cancel.` : 'To connect devices, select the double-chevron on the first card and then on the destination card.'}</div>
    <div class="topology-scroll" id="topology-scroll"><div class="topology-canvas" id="topology-canvas" style="width:${width}px;height:${height}px">
      <svg class="topology-links" id="topology-links" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true">${topologyLinksMarkup()}</svg>
      ${topology.nodes.map(topologyNodeMarkup).join('')}
    </div></div>
    <div class="card topology-connections"><div class="section-head compact"><div><h3>Connections</h3><p>${topology.links.length} saved link${topology.links.length === 1 ? '' : 's'}</p></div></div>${topologyConnectionRows()}</div>`;
}

function updateTopologySaveState(text, isError = false) {
  const el = $('#topology-save-state');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('error', isError);
}

async function persistTopology() {
  if (!state.topology) return;
  if (state.topologySaving) {
    state.topologySaveQueued = true;
    return;
  }
  state.topologySaving = true;
  state.topologySaveQueued = false;
  updateTopologySaveState('Saving topology…');
  try {
    await api('/api/topology', {
      method: 'PUT',
      body: JSON.stringify({
        nodes: state.topology.nodes.map(({ id, x, y }) => ({ id, x, y })),
        links: state.topology.links.map(({ sourceNodeId, targetNodeId }) => ({ sourceNodeId, targetNodeId })),
      }),
    });
    updateTopologySaveState('Saved');
    setTimeout(() => updateTopologySaveState('Drag cards to arrange them. Changes save automatically.'), 1200);
  } catch (error) {
    updateTopologySaveState(`Save failed: ${error.message}`, true);
  } finally {
    state.topologySaving = false;
    if (state.topologySaveQueued) scheduleTopologySave(0);
  }
}

function scheduleTopologySave(delay = 120) {
  clearTimeout(state.topologySaveTimer);
  state.topologySaveTimer = setTimeout(() => persistTopology(), delay);
}

function syncTopologyClientPositions(parentNodeId) {
  const node = state.topology?.nodes.find(item => item.id === Number(parentNodeId));
  const card = $(`[data-topology-client-parent="${parentNodeId}"]`);
  if (!node || !card) return;
  card.style.left = `${Number(node.x || 0) + TOPOLOGY_CARD_WIDTH + 76}px`;
  card.style.top = `${Number(node.y || 0)}px`;
}

function redrawTopologyLinks() {
  const svg = $('#topology-links');
  if (!svg || !state.topology) return;
  svg.innerHTML = topologyLinksMarkup() + topologyClientLinksMarkup();
}

function renderTopologyWorkspace() {
  if (state.page !== 'topology') return;
  const previousScroller = $('#topology-scroll');
  const scrollLeft = previousScroller?.scrollLeft || 0;
  const scrollTop = previousScroller?.scrollTop || 0;
  setContent(topologyPageMarkup(), false);
  bindTopologyInteractions();
  const nextScroller = $('#topology-scroll');
  if (nextScroller) { nextScroller.scrollLeft = scrollLeft; nextScroller.scrollTop = scrollTop; }
}

function autoArrangeTopology() {
  if (!state.topology) return;
  const perColumn = 4;
  state.topology.nodes.forEach((node, index) => {
    node.x = 70 + Math.floor(index / perColumn) * 620;
    node.y = 72 + (index % perColumn) * 220;
  });
  state.topologyConnectingFrom = null;
  renderTopologyWorkspace();
  scheduleTopologySave(0);
}

function openTopologyNode(nodeId) {
  const node = state.topology?.nodes.find(item => item.id === Number(nodeId));
  if (!node) return;
  cleanupTerminal();
  cleanupAnalyticsTimer();
  state.deviceReturnPage = 'topology';
  state.selected = node.entityId;
  state.selectedService = null;
  state.page = 'device';
  state.deviceTab = 'overview';
  renderDevice(true, true);
}

function bindTopologyInteractions() {
  $('#topology-auto-arrange')?.addEventListener('click', autoArrangeTopology);
  $('#topology-clear-links')?.addEventListener('click', () => {
    if (!state.topology?.links.length || !confirm('Remove all topology connections?')) return;
    state.topology.links = [];
    state.topologyConnectingFrom = null;
    renderTopologyWorkspace();
    scheduleTopologySave(0);
  });

  $$('[data-topology-connect]').forEach(button => button.addEventListener('click', event => {
    event.stopPropagation();
    const nodeId = Number(button.dataset.topologyConnect);
    if (!state.topology?.nodes.some(node => node.id === nodeId)) return;
    if (!state.topologyConnectingFrom) {
      state.topologyConnectingFrom = nodeId;
      return renderTopologyWorkspace();
    }
    if (state.topologyConnectingFrom === nodeId) {
      state.topologyConnectingFrom = null;
      return renderTopologyWorkspace();
    }
    const sourceNodeId = Number(state.topologyConnectingFrom);
    const targetNodeId = nodeId;
    const exists = state.topology.links.some(link =>
      (link.sourceNodeId === sourceNodeId && link.targetNodeId === targetNodeId) ||
      (link.sourceNodeId === targetNodeId && link.targetNodeId === sourceNodeId));
    if (!exists) state.topology.links.push({ sourceNodeId, targetNodeId });
    state.topologyConnectingFrom = null;
    renderTopologyWorkspace();
    scheduleTopologySave(0);
  }));

  $$('.topology-remove-link').forEach(button => button.addEventListener('click', () => {
    const index = Number(button.dataset.topologyRemoveLink);
    if (!Number.isInteger(index) || !state.topology?.links[index]) return;
    state.topology.links.splice(index, 1);
    renderTopologyWorkspace();
    scheduleTopologySave(0);
  }));

  $$('.topology-node').forEach(card => {
    card.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.target.closest('button')) return;
      const nodeId = Number(card.dataset.topologyNode);
      const node = state.topology?.nodes.find(item => item.id === nodeId);
      const canvas = $('#topology-canvas');
      if (!node || !canvas) return;
      event.preventDefault();
      card.setPointerCapture?.(event.pointerId);
      card.classList.add('dragging');
      const startPointerX = event.clientX;
      const startPointerY = event.clientY;
      const startX = Number(node.x || 0);
      const startY = Number(node.y || 0);

      const move = moveEvent => {
        if (moveEvent.pointerId !== event.pointerId) return;
        const maxX = Math.max(0, canvas.clientWidth - TOPOLOGY_CARD_WIDTH - 20);
        const maxY = Math.max(0, canvas.clientHeight - TOPOLOGY_CARD_HEIGHT - 20);
        node.x = Math.max(10, Math.min(maxX, Math.round(startX + moveEvent.clientX - startPointerX)));
        node.y = Math.max(10, Math.min(maxY, Math.round(startY + moveEvent.clientY - startPointerY)));
        card.style.left = `${node.x}px`;
        card.style.top = `${node.y}px`;
        redrawTopologyLinks();
      };
      const finish = finishEvent => {
        if (finishEvent.pointerId !== event.pointerId) return;
        card.classList.remove('dragging');
        card.removeEventListener('pointermove', move);
        card.removeEventListener('pointerup', finish);
        card.removeEventListener('pointercancel', finish);
        scheduleTopologySave(80);
      };
      card.addEventListener('pointermove', move);
      card.addEventListener('pointerup', finish);
      card.addEventListener('pointercancel', finish);
    });
  });
}

async function renderTopology(animate = true) {
  setTitle('Topology', 'Arrange network devices and save their connections');
  setContent('<div class="card topology-loading"><div class="skeleton sk-line"></div><div class="skeleton sk-line"></div><div class="skeleton sk-line"></div></div>', animate);
  try {
    state.topology = await api('/api/topology');
    if (state.page !== 'topology') return;
    state.topologyConnectingFrom = null;
    renderTopologyWorkspace();
  } catch (error) {
    if (state.page === 'topology') setContent(`<div class="notice error-notice">Unable to load topology: ${esc(error.message)}</div>`, false);
  }
}

function patchTopologyNode(entityType, entityId) {
  if (state.page !== 'topology' || !state.topology) return;
  if (entityType !== 'device') return;
  const node = state.topology.nodes.find(item => item.entityType === 'device' && item.entityId === Number(entityId));
  const card = node ? $(`.topology-node[data-topology-node="${node.id}"]`) : null;
  const entity = node ? topologyEntity(node) : null;
  const dot = card?.querySelector('.device-status-dot');
  if (dot && entity) dot.className = `device-status-dot ${entity.status}`;
  renderTopologyWorkspace();
}

function bindDeviceCards() {
  $$('[data-edit-device]').forEach(btn => { btn.onclick = e => { e.preventDefault(); e.stopPropagation(); openEditDialog('device', Number(btn.dataset.editDevice)); }; });
  $$('.device-card, .device-list-row').forEach(x => {
    const open = () => {
      if (x.classList.contains('device-card') && state.page === 'dashboard' && state.dashboardEdit.devices) return;
      cleanupTerminal();
      state.selected = Number(x.dataset.device);
      state.deviceReturnPage = state.page === 'dashboard' ? 'dashboard' : 'devices';
      state.page = 'device';
      state.deviceTab = 'overview';
      renderDevice(true, true);
    };
    x.onclick = open;
    x.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
  });
}

function bindServiceCards() {
  $$('[data-edit-service]').forEach(btn => { btn.onclick = e => { e.preventDefault(); e.stopPropagation(); openEditDialog('service', Number(btn.dataset.editService)); }; });
  $$('.service-card, .service-list-row').forEach(x => {
    const open=()=>{ if (x.classList.contains('service-card') && state.page === 'dashboard' && state.dashboardEdit.services) return; cleanupTerminal(); cleanupAnalyticsTimer(); state.serviceReturnPage=state.page === 'dashboard' ? 'dashboard' : 'devices'; state.selectedService=Number(x.dataset.service); state.selected=null; state.page='service'; state.serviceTab='overview'; renderService(true,true); };
    x.onclick=open; x.onkeydown=e=>{ if(e.key==='Enter'||e.key===' '){e.preventDefault();open();} };
  });
}

function bucketUptime(rows, count = 60, hours = 24) {
  const end = Date.now();
  const start = end - hours * 3600_000;
  const width = (end - start) / count;
  return Array.from({ length: count }, (_, i) => {
    const a = start + i * width;
    const b = a + width;
    const values = rows.filter(x => Number(x.ts) >= a && Number(x.ts) < b);
    if (!values.length) return { status: null, ts: a + width / 2 };
    const ok = values.filter(x => Number(x.status) === 1).length;
    return { status: ok / values.length >= .5 ? 1 : 0, ts: a + width / 2 };
  });
}
function uptimeBars(samples = []) {
  return `<div class="uptime-bars">${samples.map(x => {
    const cls = x.status == null ? '' : Number(x.status) === 1 ? 'up' : 'down';
    return `<span class="${cls}" title="${esc(formatDateTime(x.ts))}"></span>`;
  }).join('')}</div>`;
}
function uptimeRow(d, h) {
  const buckets = bucketUptime(h);
  const ok = h.filter(x => Number(x.status) === 1).length;
  const pct = h.length ? (ok / h.length) * 100 : null;
  const u = state.uptime.get(d.id);
  return `<div class="uptime-row" data-uptime-device="${d.id}"><div><div class="uptime-name-line">${deviceIcon(d,'uptime-icon')}<span class="status-dot ${statusOf(d)}"></span><b>${esc(d.name)}</b></div><div class="device-host">${esc(d.host)}</div></div>${uptimeBars(buckets)}<div><b>${pct == null ? '—' : `${pct.toFixed(2)}%`}</b><div class="uptime-label" data-uptime-latency>24h • ${fmtLatency(u?.latency_ms)}</div></div></div>`;
}
function serviceUptimeRow(service, h) {
  const buckets = bucketUptime(h);
  const ok = h.filter(x => Number(x.status) === 1).length;
  const pct = h.length ? (ok / h.length) * 100 : null;
  const u = state.serviceUptime.get(service.id) || service.uptime;
  const status = u ? (Number(u.status) === 1 ? 'up' : 'down') : 'unknown';
  return `<div class="uptime-row" data-uptime-service="${service.id}"><div><div class="uptime-name-line">${serviceIcon(service.serviceType,'uptime-icon')}<span class="status-dot ${status}"></span><b>${esc(service.name)}</b></div><div class="device-host">${esc(serviceWebUrl(service))}</div></div>${uptimeBars(buckets)}<div><b>${pct == null ? '—' : `${pct.toFixed(2)}%`}</b><div class="uptime-label" data-uptime-latency>24h • ${fmtLatency(u?.latency_ms)}</div></div></div>`;
}

async function renderUptime(animate = true) {
  setTitle('Uptime', 'Device reachability and network-service API availability');
  if (animate) setContent(uptimeSkeleton(), true);
  const [settings, deviceRows, serviceRows] = await Promise.all([
    api('/api/status-settings').catch(() => ({ title: 'Network Status', subtitle: '', showHosts: false, refreshSeconds: 30, accent: '#6f8cff' })),
    Promise.all(state.devices.map(async d => ({ d, h: await api(`/api/devices/${d.id}/uptime?hours=24`).catch(() => []) }))),
    Promise.all(state.services.map(async service => ({ service, h: await api(`/api/services/${service.id}/uptime?hours=24`).catch(() => []) }))),
  ]);
  setContent(`<div class="status-admin-grid">
    <div class="card status-settings-card">
      <div class="section-head compact"><div><h2>Public status page</h2><p>Available without login at <span class="mono">/status</span>.</p></div><a class="ghost link-button" href="/status" target="_blank" rel="noopener">Open status ↗</a></div>
      <form id="status-settings-form" class="status-settings-form">
        <label>Page title<input name="title" maxlength="80" value="${esc(settings.title)}" /></label>
        <label>Subtitle<input name="subtitle" maxlength="240" value="${esc(settings.subtitle)}" /></label>
        <label>Auto refresh (seconds)<input name="refreshSeconds" type="number" min="10" max="300" value="${Number(settings.refreshSeconds || 30)}" /></label>
        <label class="check"><input name="showHosts" type="checkbox" ${settings.showHosts ? 'checked' : ''} /> Show IP/hostnames for devices and services on the public page</label>
        <div class="settings-actions"><span id="status-settings-result" class="muted"></span><button type="submit" class="primary save-preference-button" aria-label="Save uptime settings">${heroIcon('save','save-mobile-icon')}<span class="save-button-text">Save</span></button></div>
      </form>
    </div>
    <div class="card status-preview-card"><div class="stat-label">Public endpoint</div><div class="status-url mono">/status</div><p>Read-only uptime data only. Router credentials, SSH, metrics and client information stay behind login.</p></div>
  </div>
  <div class="section-head"><div><h2>24-hour uptime</h2><p>Each bar represents a time bucket across the last 24 hours.</p></div></div>
  <div class="card uptime-list">${[...deviceRows.map(({ d, h }) => uptimeRow(d, h)), ...serviceRows.map(({ service, h }) => serviceUptimeRow(service, h))].join('') || '<div class="empty">No devices or services configured.</div>'}</div>`, false);

  $('#status-settings-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const result = $('#status-settings-result');
    result.textContent = 'Saving…';
    try {
      await api('/api/status-settings', {
        method: 'PATCH',
        body: JSON.stringify({
          title: f.get('title'), subtitle: f.get('subtitle'),
          refreshSeconds: Number(f.get('refreshSeconds') || 30),
          showHosts: f.has('showHosts'),
        }),
      });
      result.textContent = 'Saved';
      setTimeout(() => { if (result) result.textContent = ''; }, 1800);
    } catch (err) { result.textContent = err.message; }
  });
}

function telegramRecipientCard(r, devices, services) {
  const checked = (ids, id) => (ids || []).includes(id) ? 'checked' : '';
  const deviceOptions = devices.map(d => `<label class="check tg-scope-item"><input type="checkbox" data-tg-device="${d.id}" ${checked(r.deviceIds, d.id)} /> ${esc(d.name)} <span class="mono">${esc(d.host)}</span></label>`).join('')
    || '<div class="muted tg-empty">No devices configured.</div>';
  const serviceOptions = services.map(s => `<label class="check tg-scope-item"><input type="checkbox" data-tg-service="${s.id}" ${checked(r.serviceIds, s.id)} /> ${esc(s.name)}</label>`).join('')
    || '<div class="muted tg-empty">No services configured.</div>';
  return `<div class="card tg-recipient" data-recipient-id="${r.id}">
    <div class="tg-recipient-head">
      <b>${esc(r.label || r.chatId)}</b><span class="mono">${esc(r.chatId)}</span>
      <button type="button" class="ghost" data-tg-test="${r.id}">Test</button>
      <button type="button" class="ghost danger-button" data-tg-delete="${r.id}">Remove</button>
    </div>
    <div class="settings-form-grid">
      <label>Label<input data-tg-label value="${esc(r.label || '')}" placeholder="e.g. Living room chat" /></label>
      <label>Chat ID<input data-tg-chatid value="${esc(r.chatId)}" placeholder="123456789 or -100… (groups)" /></label>
      <label class="check"><input type="checkbox" data-tg-enabled ${r.enabled ? 'checked' : ''} /> Active</label>
      <label class="check"><input type="checkbox" data-tg-down ${r.notifyDown ? 'checked' : ''} /> Notify on DOWN</label>
      <label class="check"><input type="checkbox" data-tg-up ${r.notifyUp ? 'checked' : ''} /> Notify on UP</label>
      <label class="span2">Route to<select data-tg-scope>
        <option value="all" ${r.scope !== 'selected' ? 'selected' : ''}>All devices and services</option>
        <option value="selected" ${r.scope === 'selected' ? 'selected' : ''}>Only the devices / services selected below</option>
      </select></label>
    </div>
    <details class="tg-scope-picker" ${r.scope === 'selected' ? 'open' : ''}><summary>Devices <span class="muted">(alerts this chat)</span></summary><div class="tg-scope-box">${deviceOptions}</div></details>
    <details class="tg-scope-picker" ${r.scope === 'selected' ? 'open' : ''}><summary>Services <span class="muted">(alerts this chat)</span></summary><div class="tg-scope-box">${serviceOptions}</div></details>
    <div class="settings-actions"><span class="muted tg-recipient-result" data-tg-result="${r.id}"></span><button type="button" class="primary save-preference-button" data-tg-save="${r.id}">${heroIcon('save','save-mobile-icon')}<span class="save-button-text">Save chat</span></button></div>
  </div>`;
}

async function renderSettings(animate = true) {
  setTitle('Settings', 'Customize RouterDeck appearance and clock');
  if (animate) setContent(`<div class="settings-grid"><div class="card skeleton-panel">${Array.from({ length: 6 }, () => '<div class="skeleton sk-line"></div>').join('')}</div></div>`, true);
  const [settings, telegram] = await Promise.all([
    api('/api/app-settings').catch(() => state.appSettings),
    api('/api/telegram-settings').catch(() => ({ enabled: false, botTokenSet: false, recipients: [] })),
  ]);
  applyAppSettings(settings);
  setTitle('Settings', `Customize ${state.appSettings.appName || 'RouterDeck'} appearance and clock`);
  setContent(`<div class="settings-grid">
    <form id="app-settings-form" class="card app-settings-card">
      <div class="section-head compact"><div><h2>Web application</h2><p>Global RouterDeck display preferences for this installation.</p></div></div>
      <div class="settings-form-grid">
        <label class="span2">Web app name<input name="appName" maxlength="48" value="${esc(settings.appName || 'RouterDeck')}" placeholder="RouterDeck" /></label>
        <label>Clock format<select name="clockFormat"><option value="24h" ${settings.clockFormat === '24h' ? 'selected' : ''}>24-hour (23.45)</option><option value="12h" ${settings.clockFormat === '12h' ? 'selected' : ''}>12-hour (11.45 PM)</option></select></label>
        <label>Theme<select name="theme"><option value="system" ${settings.theme === 'system' ? 'selected' : ''}>System · Latte / Mocha</option><option value="latte" ${settings.theme === 'latte' ? 'selected' : ''}>Catppuccin Latte</option><option value="frappe" ${settings.theme === 'frappe' ? 'selected' : ''}>Catppuccin Frappé</option><option value="macchiato" ${settings.theme === 'macchiato' ? 'selected' : ''}>Catppuccin Macchiato</option><option value="mocha" ${settings.theme === 'mocha' ? 'selected' : ''}>Catppuccin Mocha</option><option value="amoled" ${settings.theme === 'amoled' ? 'selected' : ''}>AMOLED Black</option></select></label>
        <label class="span2">Time zone<select name="timeZone" id="time-zone-select">${timeZoneOptions(settings.timeZone || 'auto')}</select></label>
      </div>
      <div class="settings-preview"><div>${brandLogo('settings-brand-logo')}<div><strong id="settings-name-preview">${esc(settings.appName || 'RouterDeck')}</strong><span>Clock preview</span></div></div><b id="settings-clock-preview">${formatClockTime()}</b></div>
      <div class="settings-actions"><span id="app-settings-result" class="muted"></span><button type="submit" class="primary save-preference-button" aria-label="Save settings">${heroIcon('save','save-mobile-icon')}<span class="save-button-text">Save</span></button></div>
    </form>
    <div class="card telegram-settings-card">
      <div class="section-head compact"><div><h2>Telegram notifications</h2><p>Send a message when a device or service goes down, and another when it comes back online. Add several chats and route each one to specific devices or services.</p></div></div>
      <form id="telegram-master-form" class="telegram-master-form">
        <div class="settings-form-grid">
          <label class="check span2"><input name="enabled" type="checkbox" ${telegram.enabled ? 'checked' : ''} /> Enable Telegram notifications</label>
          <label class="span2">Bot token<input name="botToken" type="password" autocomplete="new-password" placeholder="${telegram.botTokenSet ? '••••••••  stored — leave blank to keep it' : '123456789:AA…  (create a bot with @BotFather)'}" /></label>
        </div>
        <div class="settings-actions"><span id="telegram-master-result" class="muted"></span><button type="submit" class="primary save-preference-button" aria-label="Save Telegram settings">${heroIcon('save','save-mobile-icon')}<span class="save-button-text">Save</span></button></div>
      </form>
      <div class="telegram-recipient-list">
        ${(telegram.recipients || []).map(r => telegramRecipientCard(r, state.devices, state.services)).join('')}
        <button type="button" class="ghost button-with-icon" id="telegram-add-recipient">${heroIcon('plus')}<span>Add chat</span></button>
      </div>
      <p class="form-hint">The bot token is stored encrypted and never shown again. Get your chat ID from @userinfobot, or add the bot to a group and use the group chat ID (starts with a minus sign). Alerts are sent only when a status changes — not on every check.</p>
    </div>
    <div class="card config-backup-card">
      <div class="section-head compact"><div><h2>Configuration backup</h2><p>Back up devices, network services, encrypted credentials and web/status settings. Monitoring history is not included.</p></div></div>
      <label>Backup password <span class="muted">(optional)</span><input id="backup-password" type="password" autocomplete="new-password" placeholder="Recommended for portable backups" /></label>
      <p class="form-hint">With a password, the backup can be restored on another RouterDeck installation. Without one, it is encrypted with this installation's APP_SECRET.</p>
      <div class="backup-actions"><button type="button" class="primary" id="download-config-backup">Download backup</button><label class="ghost file-button">Restore backup<input id="restore-config-file" type="file" accept="application/json,.json" hidden /></label></div>
      <div id="config-backup-result" class="muted control-result"></div>
    </div>
    <div class="card settings-note"><div class="stat-label">Theme palette</div><h3>${themeLabel(settings.theme)}</h3><p>System mode automatically uses Catppuccin Latte for a light system appearance and Catppuccin Mocha for a dark appearance. Frappé and Macchiato are also available as fixed themes, plus AMOLED Black for OLED displays.</p><div class="theme-swatches" aria-hidden="true"><span class="latte"></span><span class="frappe"></span><span class="macchiato"></span><span class="mocha"></span><span class="amoled"></span></div></div>
    <div class="card settings-session-card"><div><div class="stat-label">Session</div><h3>Sign out</h3><p>End this RouterDeck session on the current browser.</p></div><button type="button" class="ghost danger-button button-with-icon" id="settings-logout">${heroIcon('back')}<span>Logout</span></button></div>
  </div>`, false);

  const form = $('#app-settings-form');
  const previewName = $('#settings-name-preview');
  const previewClock = $('#settings-clock-preview');
  const nameInput = form?.querySelector('[name=appName]');
  const clockSelect = form?.querySelector('[name=clockFormat]');
  const timeZoneSelect = form?.querySelector('[name=timeZone]');
  nameInput?.addEventListener('input', () => { if (previewName) previewName.textContent = nameInput.value.trim() || 'RouterDeck'; });
  const updateClockPreview = () => {
    const oldFormat = state.appSettings.clockFormat;
    const oldZone = state.appSettings.timeZone;
    state.appSettings.clockFormat = clockSelect?.value || oldFormat;
    state.appSettings.timeZone = timeZoneSelect?.value || oldZone;
    if (previewClock) previewClock.textContent = formatClockTime();
    state.appSettings.clockFormat = oldFormat;
    state.appSettings.timeZone = oldZone;
  };
  clockSelect?.addEventListener('change', updateClockPreview);
  timeZoneSelect?.addEventListener('change', updateClockPreview);
  form?.addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const result = $('#app-settings-result');
    result.textContent = 'Saving…';
    try {
      const saved = await api('/api/app-settings', { method: 'PATCH', body: JSON.stringify({ appName: f.get('appName'), clockFormat: f.get('clockFormat'), theme: f.get('theme'), timeZone: f.get('timeZone') }) });
      applyAppSettings(saved);
      startClock();
      setTitle('Settings', `Customize ${saved.appName || 'RouterDeck'} appearance and clock`);
      result.textContent = 'Saved';
      if (previewName) previewName.textContent = saved.appName;
      if (previewClock) previewClock.textContent = formatClockTime();
      setTimeout(() => { if (result) result.textContent = ''; }, 1800);
    } catch (err) { result.textContent = err.message; }
  });


  $('#telegram-master-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const result = $('#telegram-master-result');
    result.textContent = 'Saving…';
    try {
      const saved = await api('/api/telegram-settings', { method: 'PATCH', body: JSON.stringify({
        enabled: f.has('enabled'), botToken: f.get('botToken') || '',
      }) });
      if (f.get('botToken')) { const input = e.currentTarget.querySelector('[name=botToken]'); if (input) input.value = ''; }
      result.textContent = saved.enabled ? 'Saved — notifications enabled' : 'Saved — notifications off';
      setTimeout(() => { if (result) result.textContent = ''; }, 2400);
    } catch (err) { result.textContent = err.message; }
  });

  document.querySelectorAll('.tg-recipient').forEach(card => {
    const id = Number(card.dataset.recipientId);
    const resultEl = card.querySelector(`[data-tg-result="${id}"]`);
    card.querySelector('[data-tg-save]')?.addEventListener('click', async () => {
      resultEl.textContent = 'Saving…';
      try {
        await api(`/api/telegram/recipients/${id}`, { method: 'PATCH', body: JSON.stringify({
          chatId: card.querySelector('[data-tg-chatid]').value || '',
          label: card.querySelector('[data-tg-label]').value || '',
          enabled: card.querySelector('[data-tg-enabled]').checked,
          notifyDown: card.querySelector('[data-tg-down]').checked,
          notifyUp: card.querySelector('[data-tg-up]').checked,
          scope: card.querySelector('[data-tg-scope]').value,
          deviceIds: [...card.querySelectorAll('[data-tg-device]:checked')].map(el => Number(el.dataset.tgDevice)),
          serviceIds: [...card.querySelectorAll('[data-tg-service]:checked')].map(el => Number(el.dataset.tgService)),
        }) });
        resultEl.textContent = 'Saved';
        setTimeout(() => { resultEl.textContent = ''; }, 1800);
      } catch (err) { resultEl.textContent = err.message; }
    });
    card.querySelector('[data-tg-test]')?.addEventListener('click', async () => {
      const chatId = card.querySelector('[data-tg-chatid]').value.trim();
      if (!chatId) { resultEl.textContent = 'Enter a chat ID first'; return; }
      resultEl.textContent = 'Sending…';
      try {
        await api('/api/telegram/test', { method: 'POST', body: JSON.stringify({ chatId }) });
        resultEl.textContent = 'Test message sent — check Telegram';
        setTimeout(() => { resultEl.textContent = ''; }, 2400);
      } catch (err) { resultEl.textContent = `Test failed: ${err.message}`; }
    });
    card.querySelector('[data-tg-delete]')?.addEventListener('click', async () => {
      const label = card.querySelector('[data-tg-label]').value || card.querySelector('[data-tg-chatid]').value;
      if (!confirm(`Remove Telegram chat "${label}"?`)) return;
      try {
        await api(`/api/telegram/recipients/${id}`, { method: 'DELETE' });
        renderSettings(false);
      } catch (err) { resultEl.textContent = err.message; }
    });
  });
  $('#telegram-add-recipient')?.addEventListener('click', async () => {
    const chatId = prompt('Chat ID for the new channel (numeric, or -100… for groups):');
    if (!chatId || !chatId.trim()) return;
    try {
      await api('/api/telegram/recipients', { method: 'POST', body: JSON.stringify({ chatId: chatId.trim() }) });
      renderSettings(false);
    } catch (err) { alert(`Could not add chat: ${err.message}`); }
  });

  $('#settings-logout')?.addEventListener('click', logoutFromRouterDeck);

  $('#download-config-backup')?.addEventListener('click', async () => {
    const result = $('#config-backup-result');
    const password = $('#backup-password')?.value || '';
    if (result) result.textContent = 'Creating encrypted backup…';
    try {
      const backup = await api('/api/config-backup/export', { method:'POST', body:JSON.stringify({ password }) });
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type:'application/json' });
      const url = URL.createObjectURL(blob); const a = document.createElement('a');
      const stamp = new Date().toISOString().replace(/[:.]/g,'-'); a.href=url; a.download=`routerdeck-config-${stamp}.json`; a.click(); URL.revokeObjectURL(url);
      if (result) result.textContent = password ? 'Portable encrypted backup downloaded.' : 'Backup downloaded. Keep APP_SECRET unchanged to restore it.';
    } catch (err) { if (result) result.textContent = err.message; }
  });
  $('#restore-config-file')?.addEventListener('change', async e => {
    const file = e.currentTarget.files?.[0]; if (!file) return;
    const result = $('#config-backup-result'); const password = $('#backup-password')?.value || '';
    if (!confirm('Restore this RouterDeck configuration? Current devices/services will be replaced and their monitoring history will be cleared.')) { e.currentTarget.value=''; return; }
    if (result) result.textContent = 'Restoring configuration…';
    try {
      const backup = JSON.parse(await file.text());
      const restored = await api('/api/config-backup/restore', { method:'POST', body:JSON.stringify({ backup, password }) });
      if (result) result.textContent = `Restored ${restored.devices} devices and ${restored.services} services.`;
      await Promise.all([refreshDevices(), refreshServices()]);
      const fresh = await api('/api/app-settings'); applyAppSettings(fresh); startClock();
      setTimeout(()=>renderSettings(false),700);
    } catch (err) { if (result) result.textContent = err.message; }
    e.currentTarget.value='';
  });
}

function lineChart(rows, key) {
  const clean = rows.filter(r => Number.isFinite(Number(r[key])));
  if (clean.length < 2) return '<div class="empty">Waiting for metric samples…</div>';
  const vals = clean.map(r => Number(r[key]));
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const pts = clean.map((r, i) => {
    const v = Number(r[key]);
    const x = (i / (clean.length - 1)) * 1000;
    const y = 150 - ((v - min) / span) * 140;
    return `${x},${y}`;
  }).join(' ');
  return `<div class="chart"><svg viewBox="0 0 1000 160" preserveAspectRatio="none"><polyline points="${pts}"/></svg></div>`;
}

function bandwidthSeries(rows = [], maxPoints = 140) {
  const sorted = [...rows].sort((a, b) => Number(a.ts) - Number(b.ts));
  const rates = [];
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    const dt = (Number(b.ts) - Number(a.ts)) / 1000;
    const arx = Number(a.rx_bytes), brx = Number(b.rx_bytes);
    const atx = Number(a.tx_bytes), btx = Number(b.tx_bytes);
    if (!Number.isFinite(dt) || dt <= 0 || dt > 900) continue;
    const rxDelta = brx - arx;
    const txDelta = btx - atx;
    if (!Number.isFinite(rxDelta) || !Number.isFinite(txDelta) || rxDelta < 0 || txDelta < 0) continue;
    rates.push({ ts: Number(b.ts), rx: (rxDelta * 8) / dt, tx: (txDelta * 8) / dt });
  }
  if (rates.length <= maxPoints) return rates;
  const size = Math.ceil(rates.length / maxPoints);
  const out = [];
  for (let i = 0; i < rates.length; i += size) {
    const group = rates.slice(i, i + size);
    out.push({
      ts: group[Math.floor(group.length / 2)].ts,
      rx: group.reduce((n, x) => n + x.rx, 0) / group.length,
      tx: group.reduce((n, x) => n + x.tx, 0) / group.length,
    });
  }
  return out;
}

function bandwidthChart(rows = []) {
  const data = bandwidthSeries(rows);
  if (data.length < 2) return '<div class="empty">Waiting for enough RX/TX counter samples to calculate bandwidth…</div>';
  const max = Math.max(1, ...data.flatMap(x => [x.rx, x.tx]));
  const points = key => data.map((r, i) => {
    const x = (i / (data.length - 1)) * 1000;
    const y = 170 - (Math.max(0, r[key]) / max) * 150;
    return `${x},${y}`;
  }).join(' ');
  const latest = data.at(-1);
  const ticks = [1, .75, .5, .25, 0];
  return `<div class="bandwidth-chart">
    <div class="bandwidth-legend"><span><i class="rx-line"></i> RX <b>${fmtBitsPerSec(latest.rx)}</b></span><span><i class="tx-line"></i> TX <b>${fmtBitsPerSec(latest.tx)}</b></span><span class="muted">peak ${fmtBitsPerSec(max)}</span></div>
    <div class="bandwidth-plot"><div class="bandwidth-y">${ticks.map(t => `<span>${fmtBitsPerSec(max * t)}</span>`).join('')}</div><svg viewBox="0 0 1000 180" preserveAspectRatio="none" aria-label="Bandwidth traffic graph">
      ${[20,57.5,95,132.5,170].map(y => `<line class="grid-line" x1="0" x2="1000" y1="${y}" y2="${y}"/>`).join('')}
      <polyline class="bandwidth-rx" points="${points('rx')}"/><polyline class="bandwidth-tx" points="${points('tx')}"/>
    </svg></div>
    <div class="bandwidth-axis"><span>${new Date(data[0].ts).toLocaleTimeString([], dateOptionsWithZone({hour:'2-digit', minute:'2-digit', hour12:clockHour12()})).replace(/:/g,'.')}</span><span>${new Date(data.at(-1).ts).toLocaleTimeString([], dateOptionsWithZone({hour:'2-digit', minute:'2-digit', hour12:clockHour12()})).replace(/:/g,'.')}</span></div>
  </div>`;
}

const trafficState = { deviceId: null, iface: null, samples: [], last: null };

function trafficHostDevice() {
  return state.devices.find(d => d.osType === 'mikrotik' && d.deviceRole === 'host');
}

function trafficDefaultIface(d, metric) {
  const ifaces = Array.isArray(metric.interfaces) ? metric.interfaces : [];
  if (!ifaces.length) return null;
  const preferred = d.monitorInterface || metric.deviceInfo?.monitorInterface || '';
  if (preferred && ifaces.some(i => i.name === preferred)) return preferred;
  return ifaces[0].name;
}

function recordTrafficSample(deviceId) {
  const host = trafficHostDevice();
  if (!host || deviceId !== host.id || state.page !== 'dashboard') return;
  const metric = state.live.get(host.id);
  const ifaces = Array.isArray(metric?.interfaces) ? metric.interfaces : [];
  if (!ifaces.length) return renderTrafficCard();
  const iface = trafficState.iface || trafficDefaultIface(host, metric);
  if (!iface) return renderTrafficCard();
  const row = ifaces.find(i => i.name === iface) || ifaces[0];
  const key = `${host.id}:${row.name}`;
  const now = Date.now();
  if (trafficState.key !== key) { trafficState.key = key; trafficState.samples = []; trafficState.last = null; }
  const last = trafficState.last;
  if (last && Number.isFinite(row.rxBytes) && Number.isFinite(row.txBytes)) {
    const dt = (now - last.t) / 1000;
    if (dt > 0 && dt < 600) {
      const drx = Number(row.rxBytes) - Number(last.rx);
      const dtx = Number(row.txBytes) - Number(last.tx);
      if (Number.isFinite(drx) && Number.isFinite(dtx) && drx >= 0 && dtx >= 0) {
        trafficState.samples.push({ t: now, down: (drx * 8) / dt, up: (dtx * 8) / dt });
        if (trafficState.samples.length > 60) trafficState.samples.shift();
      }
    }
  }
  trafficState.last = { t: now, rx: row.rxBytes, tx: row.txBytes };
  renderTrafficCard();
}

function trafficSectionHTML() {
  const host = trafficHostDevice();
  if (!host) return '';
  const metric = state.live.get(host.id) || {};
  const ifaces = Array.isArray(metric.interfaces) ? metric.interfaces : [];
  if (!ifaces.length) return `<div class="section-head dashboard-section-head"><div><h2>Realtime traffic</h2><p>Live download / upload for the MikroTik host's monitored interfaces.</p></div></div><div class="card traffic-card"><div class="empty">Waiting for interface metrics from ${esc(host.name)}…</div></div>`;
  const selected = trafficState.iface && ifaces.some(i => i.name === trafficState.iface) ? trafficState.iface : trafficDefaultIface(host, metric);
  return `<div class="section-head dashboard-section-head"><div><h2>Realtime traffic</h2><p>Live download / upload for the MikroTik host's monitored interfaces.</p></div>
    <label class="traffic-iface-picker">${heroIcon('arrows-right-left')}<select id="traffic-interface" aria-label="Traffic interface">${ifaces.map(i => `<option value="${esc(i.name)}" ${i.name === selected ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}</select></label></div>
    <div id="traffic-chart" class="card traffic-card">${trafficChartBody(selected)}</div>`;
}

function trafficChartBody(iface) {
  const samples = trafficState.samples;
  if (samples.length < 2) return `<div class="empty">Collecting traffic samples for <span class="mono">${esc(iface || '')}</span>…</div>`;
  const max = Math.max(1, ...samples.flatMap(s => [s.down, s.up]));
  const pts = key => samples.map((s, i) => { const x = (i / (samples.length - 1)) * 1000; const y = 170 - (Math.max(0, s[key]) / max) * 150; return `${x},${y}`; }).join(' ');
  const latest = samples.at(-1);
  return `<div class="bandwidth-chart">
    <div class="bandwidth-legend"><span><i class="rx-line"></i> ↓ Download <b>${fmtBitsPerSec(latest.down)}</b></span><span><i class="tx-line"></i> ↑ Upload <b>${fmtBitsPerSec(latest.up)}</b></span><span class="muted">peak ${fmtBitsPerSec(max)}</span></div>
    <div class="bandwidth-plot"><div class="bandwidth-y">${[1, .75, .5, .25, 0].map(t => `<span>${fmtBitsPerSec(max * t)}</span>`).join('')}</div><svg viewBox="0 0 1000 180" preserveAspectRatio="none" aria-label="Realtime interface traffic graph">
      ${[20, 57.5, 95, 132.5, 170].map(y => `<line class="grid-line" x1="0" x2="1000" y1="${y}" y2="${y}"/>`).join('')}
      <polyline class="bandwidth-rx" points="${pts('down')}"/><polyline class="bandwidth-tx" points="${pts('up')}"/>
    </svg></div>
    <div class="bandwidth-axis"><span>${formatClockTime(new Date(samples[0].t))}</span><span>${formatClockTime(new Date(samples.at(-1).t))}</span></div>
  </div>`;
}

function renderTrafficCard() {
  const select = $('#traffic-interface');
  const chart = $('#traffic-chart');
  if (!chart) return;
  const host = trafficHostDevice();
  const metric = state.live.get(host?.id) || {};
  const ifaces = Array.isArray(metric.interfaces) ? metric.interfaces : [];
  const current = select?.value || trafficState.iface || trafficDefaultIface(host, metric) || '';
  if (select && current && select.value !== current) select.value = current;
  chart.innerHTML = trafficChartBody(current);
}

function bindTrafficPicker() {
  $('#traffic-interface')?.addEventListener('change', e => {
    trafficState.iface = e.currentTarget.value;
    trafficState.samples = [];
    trafficState.last = null;
    trafficState.key = null;
    renderTrafficCard();
  });
}

function deviceSummaryCards(live, d = null) {
  if (d?.osType === 'ruijie') return `<div class="cards" id="device-summary">
    <div class="card"><div class="stat-label">Cloud status</div><div class="stat-value smaller ${String(live.deviceInfo?.cloudStatus).toUpperCase()==='ONLINE'?'status-text up':''}">${esc(live.deviceInfo?.cloudStatus || 'Unknown')}</div></div>
    <div class="card"><div class="stat-label">Switch ports</div><div class="stat-value">${Array.isArray(live.interfaces)?live.interfaces.length:0}</div></div>
    <div class="card"><div class="stat-label">Connected clients</div><div class="stat-value" data-live="clients">${clientCount(live)}</div></div>
    <div class="card"><div class="stat-label">Firmware</div><div class="stat-value smaller">${esc(live.version || live.deviceInfo?.version || '—')}</div></div>
  </div>`;
  return `<div class="cards" id="device-summary">
    <div class="card"><div class="stat-label">CPU</div><div class="stat-value" data-live="cpu">${fmtPct(live.cpu)}</div></div>
    <div class="card"><div class="stat-label">Memory</div><div class="stat-value" data-live="memory">${fmtPct(memoryPercent(live))}</div></div>
    <div class="card"><div class="stat-label">Uptime</div><div class="stat-value" data-live="uptime">${fmtUptime(live.uptimeSec ?? live.uptime_sec)}</div></div>
    <div class="card"><div class="stat-label">Connected clients</div><div class="stat-value" data-live="clients">${clientCount(live)}</div></div>
  </div>`;
}

function infoItem(label, value, mono = false) {
  const display = value === null || value === undefined || value === '' ? '—' : value;
  return `<div class="info-item"><span>${esc(label)}</span><b class="${mono ? 'mono' : ''}">${esc(display)}</b></div>`;
}


function countryFlag(code = '') {
  const c = String(code).toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return '🌐';
  return String.fromCodePoint(...[...c].map(ch => 127397 + ch.charCodeAt(0)));
}

function rolePanel(d) {
  if (d.osType === 'openwrt') {
    const ap = d.deviceRole === 'access_point';
    return `<div class="card mikrotik-role-card"><div><div class="stat-label">OpenWrt role</div><h3>${ap ? 'Access point' : 'Client'}</h3><p>${ap ? 'Access-point mode keeps RouterDeck focused on wireless, ports and clients.' : 'Client mode enables router-oriented controls including MAC-based internet blocking.'}</p></div><div class="role-controls"><select id="device-role-select" aria-label="OpenWrt role"><option value="client" ${!ap ? 'selected' : ''}>Client</option><option value="access_point" ${ap ? 'selected' : ''}>Access point</option></select><button type="button" class="primary" id="save-device-role">Apply</button></div></div>`;
  }
  if (d.osType !== 'mikrotik') return '';
  const otherHost=state.devices.find(x=>x.osType==='mikrotik'&&x.deviceRole==='host'&&x.id!==d.id);
  return `<div class="card mikrotik-role-card"><div><div class="stat-label">MikroTik role</div><h3>${d.deviceRole === 'host' ? 'Host / gateway' : 'Client / managed device'}</h3><p>${d.deviceRole === 'host' ? 'This is the network gateway used by the Connection analytics section on the main Overview.' : otherHost ? `${esc(otherHost.name)} is already the Host / gateway. Only one gateway can be active.` : 'Set this router as Host / gateway to enable connection analytics on the main Overview.'}</p></div><div class="role-controls"><select id="device-role-select" aria-label="MikroTik role"><option value="client" ${d.deviceRole !== 'host' ? 'selected' : ''}>Client / managed device</option><option value="host" ${d.deviceRole === 'host' ? 'selected' : ''} ${otherHost ? 'disabled' : ''}>Host / gateway</option></select><button type="button" class="primary" id="save-device-role">Apply</button></div></div>`;
}

function analyticsSkeleton() {
  return `<div class="host-analytics"><div class="cards connection-stat-cards">${Array.from({length:6},()=>'<div class="card skeleton-panel"><div class="skeleton sk-line"></div><div class="skeleton sk-title"></div></div>').join('')}</div><div class="analytics-grid"><div class="card skeleton-panel tall"></div><div class="card skeleton-panel tall"></div></div></div>`;
}

function miniRankList(rows = [], kind = 'source') {
  if (!rows.length) return '<div class="empty compact-empty">No active connection data.</div>';
  const max = Math.max(1, ...rows.map(x => Number(x.connections) || 0));
  return `<div class="rank-list">${rows.map((x, idx) => {
    const label = kind === 'destination' && x.geo?.countryCode ? `${countryFlag(x.geo.countryCode)} ${x.key}` : x.key;
    return `<div class="rank-row"><span class="rank-num">${idx + 1}</span><div class="rank-main"><div><b>${esc(x.name ? `${x.name} · ${label}` : label)}</b><span>${fmtBitsPerSec(x.rate || 0)}</span></div><div class="rank-track"><i style="width:${Math.max(4, (Number(x.connections)||0)/max*100)}%"></i></div></div><strong>${Number(x.connections)||0}</strong></div>`;
  }).join('')}</div>`;
}

function worldConnectionMap(map = {}) {
  const countries = Array.isArray(map.countries) ? map.countries : [];
  if (!countries.length) return '<div class="empty compact-empty">No public destinations could be geolocated yet.</div>';
  const project = (lat, lon) => ({ x: ((Number(lon) + 180) / 360) * 1000, y: ((90 - Number(lat)) / 180) * 500 });
  const origin = map.origin && Number.isFinite(Number(map.origin.lat)) && Number.isFinite(Number(map.origin.lon)) ? project(map.origin.lat, map.origin.lon) : null;
  const max = Math.max(1, ...countries.map(c => Number(c.connections)||0));
  const arcs = origin ? countries.map(c => {
    const p = project(c.lat, c.lon); const mx=(origin.x+p.x)/2; const my=Math.min(origin.y,p.y)-Math.max(35,Math.abs(origin.x-p.x)*.08);
    return `<path class="map-arc" d="M ${origin.x.toFixed(1)} ${origin.y.toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)} ${p.x.toFixed(1)} ${p.y.toFixed(1)}"/>`;
  }).join('') : '';
  const points = countries.map(c => { const p=project(c.lat,c.lon); const r=4+Math.sqrt((Number(c.connections)||1)/max)*8; return `<g class="map-point"><circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r.toFixed(1)}"/><title>${esc(c.country)}: ${c.connections} connections</title></g>`; }).join('');
  const originDot = origin ? `<g class="map-origin"><circle cx="${origin.x.toFixed(1)}" cy="${origin.y.toFixed(1)}" r="7"/><circle class="pulse" cx="${origin.x.toFixed(1)}" cy="${origin.y.toFixed(1)}" r="13"/><title>Router WAN${map.origin.ip ? ` · ${esc(map.origin.ip)}` : ''}</title></g>` : '';
  return `<div class="connection-map"><svg viewBox="0 0 1000 500" role="img" aria-label="World map of active connection countries">
    <g class="world-land">
      <path d="M58 105 115 65 180 67 229 104 214 138 165 151 137 190 91 177 62 140Z"/><path d="M208 201 253 216 274 267 254 321 237 382 207 426 189 365 195 306 174 251Z"/>
      <path d="M433 91 485 68 548 82 575 111 550 134 502 131 479 153 444 141 416 116Z"/><path d="M489 153 555 156 600 197 587 261 553 332 508 326 481 274 463 207Z"/>
      <path d="M565 88 657 63 753 79 831 118 886 156 845 191 779 183 738 215 676 197 640 158 590 147Z"/><path d="M742 225 793 219 815 251 786 279 744 270 718 246Z"/>
      <path d="M833 314 879 299 922 323 910 365 858 371 824 346Z"/><path d="M924 226 939 213 950 237 939 258Z"/>
    </g>${arcs}${originDot}${points}
  </svg><div class="map-legend"><span><i class="origin"></i>${origin ? 'Router WAN' : 'Router location unavailable'}</span><span><i class="remote"></i>Remote countries</span></div></div>`;
}

function connectionFlow(flows = []) {
  const top = flows.slice(0, 14);
  if (!top.length) return '<div class="empty compact-empty">No active flows.</div>';
  const sources = [...new Set(top.map(x => x.source))].slice(0, 7);
  const destinations = [...new Set(top.map(x => x.destination))].slice(0, 7);
  const selected = top.filter(x => sources.includes(x.source) && destinations.includes(x.destination));
  const width = 760;
  const height = Math.max(250, Math.max(sources.length, destinations.length) * 42 + 42);
  const yPos = (i, total) => total <= 1 ? height / 2 : 28 + i * ((height - 56) / (total - 1));
  const max = Math.max(1, ...selected.map(x => Number(x.connections) || 0));
  const paths = selected.map((x, idx) => {
    const sy = yPos(sources.indexOf(x.source), sources.length);
    const dy = yPos(destinations.indexOf(x.destination), destinations.length);
    const stroke = 1.4 + ((Number(x.connections) || 0) / max) * 7;
    return `<path class="flow-link" style="--flow-order:${idx}" d="M 170 ${sy.toFixed(1)} C 320 ${sy.toFixed(1)}, 440 ${dy.toFixed(1)}, 590 ${dy.toFixed(1)}" stroke-width="${stroke.toFixed(1)}"><title>${esc(x.source)} → ${esc(x.destination)} · ${x.connections} connections · ${fmtBitsPerSec(x.rate || 0)}</title></path>`;
  }).join('');
  const sourceNodes = sources.map((label, i) => `<g class="flow-node source-node"><circle cx="165" cy="${yPos(i,sources.length).toFixed(1)}" r="4"/><text x="154" y="${(yPos(i,sources.length)+4).toFixed(1)}" text-anchor="end">${esc(label)}</text></g>`).join('');
  const destNodes = destinations.map((label, i) => `<g class="flow-node destination-node"><circle cx="595" cy="${yPos(i,destinations.length).toFixed(1)}" r="4"/><text x="606" y="${(yPos(i,destinations.length)+4).toFixed(1)}">${esc(label)}</text></g>`).join('');
  return `<div class="sankey-flow"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Top source to destination connection flows">${paths}${sourceNodes}${destNodes}</svg><div class="flow-caption">Line thickness represents active connection count. Hover a flow for rate and connection details.</div></div>`;
}

function countriesList(rows = []) {
  if (!rows.length) return '<div class="empty compact-empty">No country data yet.</div>';
  const max=Math.max(1,...rows.map(x=>Number(x.connections)||0));
  return `<div class="country-list">${rows.slice(0,10).map(c=>`<div class="country-row"><span class="country-flag">${countryFlag(c.countryCode)}</span><div><b>${esc(c.country)}</b><div class="protocol-mini"><span>TCP ${c.protocols?.tcp||0}</span><span>UDP ${c.protocols?.udp||0}</span><span>ICMP ${c.protocols?.icmp||0}</span></div><div class="rank-track"><i style="width:${Math.max(4,(Number(c.connections)||0)/max*100)}%"></i></div></div><strong>${c.connections}</strong></div>`).join('')}</div>`;
}

function connectionsTable(rows = []) {
  const list=rows.slice(0,40);
  return `<div class="table-wrap connection-table"><table><thead><tr><th>Protocol</th><th>Source</th><th>Destination</th><th>State</th><th>Rate</th><th>Traffic</th><th>Country</th></tr></thead><tbody>${list.length?list.map(r=>`<tr><td><span class="protocol-pill ${esc(r.protocol)}">${esc(String(r.protocol).toUpperCase())}</span></td><td class="mono">${esc(r.src)}${r.srcPort?`:${esc(r.srcPort)}`:''}${r.srcName?`<small>${esc(r.srcName)}</small>`:''}</td><td class="mono">${esc(r.dst)}${r.dstPort?`:${esc(r.dstPort)}`:''}</td><td>${esc(r.tcpState||'—')}</td><td>${fmtBitsPerSec(r.totalRate||0)}</td><td>${fmtBytes(r.totalBytes||0)}</td><td>${r.geo?.countryCode?`${countryFlag(r.geo.countryCode)} ${esc(r.geo.country)}`:'—'}</td></tr>`).join(''):'<tr><td colspan="7" class="table-empty">No tracked connections.</td></tr>'}</tbody></table></div>`;
}

function renderConnectionAnalytics(data) {
  const p=data.protocols||{};
  const cachedNote = data.unavailable
    ? `<span class="analytics-cache-badge unavailable">Waiting for RouterOS</span><small class="analytics-cache-note">${esc(data.fetchError || 'Connection tracking is temporarily unavailable')}</small>`
    : data.cached ? `<span class="analytics-cache-badge">Cached fallback</span><small class="analytics-cache-note">Live fetch failed${data.fetchError ? ` · ${esc(data.fetchError)}` : ''}</small>` : '';
  return `<div class="host-analytics">
    <div class="section-head connection-head"><div><div class="analytics-title-line"><h2>Connection analytics</h2>${cachedNote}</div><p>${data.unavailable ? 'Waiting for a stable RouterOS connection snapshot' : data.cached ? 'Last successful RouterOS connection snapshot' : 'Live RouterOS connection tracking'} · ${Number(data.totalConnections||0).toLocaleString()} active sessions</p></div><span class="analytics-updated">${data.unavailable ? 'waiting' : data.cached ? 'cached' : 'updated'} ${formatClockTime(new Date((data.cached ? data.cacheTs : data.generatedAt)||Date.now()))}</span></div>
    <div class="cards connection-stat-cards"><div class="card"><div class="stat-label">Connections</div><div class="stat-value">${Number(data.totalConnections||0).toLocaleString()}</div></div><div class="card"><div class="stat-label">TCP</div><div class="stat-value">${Number(p.tcp||0).toLocaleString()}</div><small>${Number(data.establishedTcp||0).toLocaleString()} established</small></div><div class="card"><div class="stat-label">UDP</div><div class="stat-value">${Number(p.udp||0).toLocaleString()}</div></div><div class="card"><div class="stat-label">ICMP</div><div class="stat-value">${Number(p.icmp||0).toLocaleString()}</div></div><div class="card"><div class="stat-label">Other</div><div class="stat-value">${Number(p.other||0).toLocaleString()}</div></div><div class="card"><div class="stat-label">Live flow rate</div><div class="stat-value smaller">${fmtBitsPerSec(data.totalRate||0)}</div></div></div>
    <div class="analytics-grid"><div class="card"><div class="section-head compact"><div><h3>Top sources</h3><p>By active connection count</p></div></div>${miniRankList(data.topSources,'source')}</div><div class="card"><div class="section-head compact"><div><h3>Top destinations</h3><p>By active connection count</p></div></div>${miniRankList(data.topDestinations,'destination')}</div></div>
    <div class="analytics-grid"><div class="card"><div class="section-head compact"><div><h3>Top countries</h3><p>Protocol mix across active sessions</p></div></div>${countriesList(data.topCountries||[])}${data.geo?.available===false?`<div class="geo-note">GeoIP unavailable: ${esc(data.geo.reason||'geoip-lite could not be loaded')}</div>`:''}</div><div class="card"><div class="section-head compact"><div><h3>Top destination ports</h3><p>Most common active services</p></div></div><div class="port-list">${(data.topPorts||[]).map(x=>`<div><span class="mono">${esc(x.port)}</span><b>${x.connections}</b></div>`).join('')||'<div class="empty compact-empty">No port data.</div>'}</div></div></div>
    <div class="card"><div class="section-head compact"><div><h3>Connection flow</h3><p>Top source → destination groups</p></div></div>${connectionFlow(data.flows||[])}</div>
  </div>`;
}

async function loadDashboardHostAnalytics(d, silent = false) {
  if (d.osType !== 'mikrotik' || d.deviceRole !== 'host' || state.page !== 'dashboard') return;
  const target=$('#dashboard-connection-analytics'); if(!target) return;
  if(!silent && !state.hostAnalytics) target.innerHTML=analyticsSkeleton();
  try {
    const data=await api(`/api/devices/${d.id}/mikrotik/connections?maxRows=160`);
    if (data.unavailable && state.hostAnalytics && !state.hostAnalytics.unavailable) {
      state.hostAnalytics={...state.hostAnalytics,cached:true,fetchError:data.fetchError||'Live RouterOS query unavailable',cacheTs:state.hostAnalytics.cacheTs||state.hostAnalytics.generatedAt||state.hostAnalyticsAt};
    } else {
      state.hostAnalytics=data;
    }
    state.hostAnalyticsAt=Date.now();
    const current=$('#dashboard-connection-analytics');
    if(state.page==='dashboard' && current) current.innerHTML=renderConnectionAnalytics(state.hostAnalytics);
  } catch(err) {
    const current=$('#dashboard-connection-analytics');
    if (state.hostAnalytics && current) {
      const fallback={...state.hostAnalytics,cached:true,cacheTs:state.hostAnalytics.cacheTs||state.hostAnalytics.generatedAt||state.hostAnalyticsAt,cacheAgeMs:Date.now()-(state.hostAnalytics.cacheTs||state.hostAnalytics.generatedAt||state.hostAnalyticsAt||Date.now()),fetchError:err.message};
      state.hostAnalytics=fallback;
      current.innerHTML=renderConnectionAnalytics(fallback);
    }
  }
}

function bindRoleControl(d) {
  const btn=$('#save-device-role'); const select=$('#device-role-select');
  if(!btn||!select) return;
  btn.onclick=async()=>{
    btn.disabled=true; btn.textContent='Applying…';
    try {
      const updated=await api(`/api/devices/${d.id}`,{method:'PATCH',body:JSON.stringify({deviceRole:select.value})});
      const idx=state.devices.findIndex(x=>x.id===d.id); if(idx>=0) state.devices[idx]={...state.devices[idx],...updated};
      state.hostAnalytics=null; state.hostAnalyticsAt=0;
      cleanupAnalyticsTimer();
      await renderDevice(false,false);
    } catch(err) { btn.textContent=err.message; btn.disabled=false; }
  };
}

function deviceOverview(d, live, hist) {
  if (d.osType === 'ruijie') {
    const i = live.deviceInfo || {};
    const ready = (live.interfaces || []).filter(p => p.status === 'ready').length;
    return `<div class="overview-grid"><div class="card info-card"><div class="section-head compact"><div class="section-title-with-logo">${osIcon('ruijie','detail-os-logo')}<div><h2>Ruijie device information</h2><p>Read-only Ruijie/Reyee Cloud monitoring through pyruijie</p></div></div></div><div class="info-grid">
      ${infoItem('Cloud name', i.hostname || live.hostname || d.name)}${infoItem('Model / class', i.model || i.boardName)}${infoItem('Serial number', i.serialNumber, true)}${infoItem('Firmware', i.version || live.version)}${infoItem('Cloud status', i.cloudStatus)}${infoItem('Project / site', i.projectName)}${infoItem('Local IP', i.localIp || d.host, true)}${infoItem('Egress IP', i.egressIp, true)}${infoItem('MAC address', i.mac, true)}${infoItem('Ports', `${ready} up / ${(live.interfaces || []).length} total`)}${infoItem('Connected clients', clientCount(live))}${infoItem('Integration', 'pyruijie · Ruijie/Reyee Cloud API')}
    </div></div><div class="card"><div class="section-head compact"><div><h2>Cloud monitoring</h2><p>Switch inventory and live port state</p></div></div><div class="traffic-values"><div><span>Project</span><b>${esc(i.projectName || '—')}</b></div><div><span>Online ports</span><b>${ready}</b></div><div><span>Total ports</span><b>${(live.interfaces || []).length}</b></div><div><span>Clients</span><b>${clientCount(live)}</b></div></div></div></div>`;
  }
  const i = live.deviceInfo || {};
  const cpuBits = [i.cpu, i.cpuCount ? `${i.cpuCount} core${Number(i.cpuCount) === 1 ? '' : 's'}` : '', i.cpuFrequencyMhz ? `${i.cpuFrequencyMhz} MHz` : ''].filter(Boolean).join(' • ');
  const firmware = i.currentFirmware || i.kernel || i.firmwareType || '';
  const version = [i.os || osLabel(d.osType), i.version].filter(Boolean).join(' ');
  const rates = bandwidthSeries(hist);
  const latestRate = rates.at(-1) || {};
  return `<div class="overview-grid">
    <div class="card info-card">
      <div class="section-head compact"><div class="section-title-with-logo">${deviceIcon(d, 'detail-os-logo')}<div><h2>Device information</h2><p>Hardware and operating system</p></div></div></div>
      <div class="info-grid">
        ${infoItem('Hostname', i.hostname || live.hostname || d.name, true)}
        ${infoItem('Model', i.model || i.boardName)}
        ${infoItem('Operating system', version)}
        ${infoItem('Architecture / target', i.architecture || i.target)}
        ${infoItem('CPU', cpuBits)}
        ${infoItem('Serial number', i.serialNumber, true)}
        ${infoItem('Firmware / kernel', firmware)}
        ${infoItem('Build / revision', i.buildTime || i.revision)}
        ${infoItem('Management', d.osType === 'mikrotik' ? 'RouterOS REST API + SSH terminal' : d.osType === 'ruijie' ? 'Ruijie Cloud API' : 'SSH / ubus')}
        ${d.osType === 'mikrotik' ? infoItem('Router role', d.deviceRole === 'host' ? 'Host / gateway' : 'Client / managed device') : d.osType === 'openwrt' ? infoItem('OpenWrt role', d.deviceRole === 'access_point' ? 'Access point' : 'Client') : ''}
        ${infoItem('Monitor interface', d.monitorInterface || i.monitorInterface || live.selectedInterface || 'Automatic', true)}
        ${infoItem('Management IP', d.host, true)}
        ${infoItem('Memory', live.memoryTotal ? `${fmtBytes(live.memoryUsed)} / ${fmtBytes(live.memoryTotal)}` : '—')}
        ${infoItem('Load average (1m)', live.load1 == null ? '—' : Number(live.load1).toFixed(2))}
        ${infoItem('Connected clients', clientCount(live))}
        ${infoItem('Wi-Fi stations', wifiCount(live))}
        ${infoItem('DHCP leases', dhcpCount(live))}
      </div>
    </div>
    <div class="card traffic-card">
      <div class="section-head compact"><div><h2>Interface traffic</h2><p>${esc(d.monitorInterface || live.selectedInterface || i.monitorInterface || 'Automatic')}</p></div></div>
      <div class="traffic-values"><div><span>Received total</span><b>${fmtBytes(live.rxBytes ?? live.rx_bytes)}</b></div><div><span>Sent total</span><b>${fmtBytes(live.txBytes ?? live.tx_bytes)}</b></div><div><span>Current RX</span><b>${fmtBitsPerSec(latestRate.rx)}</b></div><div><span>Current TX</span><b>${fmtBitsPerSec(latestRate.tx)}</b></div></div>
    </div>
  </div>
  ${rolePanel(d)}
  <div class="card bandwidth-card"><div class="section-head compact"><div><h2>Bandwidth traffic</h2><p>RX/TX rate calculated from stored interface counters • last 24 hours</p></div></div>${bandwidthChart(hist)}</div>
  <div class="card history-card"><div class="section-head compact"><div><h2>CPU history</h2><p>Last 24 hours</p></div></div>${lineChart(hist, 'cpu')}</div>`;
}

function dhcpTable(leases = []) {
  const sorted = [...leases].sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)) || String(a.address).localeCompare(String(b.address), undefined, { numeric: true }));
  return `<div class="table-wrap" data-client-table="dhcp"><table><thead><tr><th>IP address</th><th>Hostname</th><th>MAC address</th><th>Status</th><th>DHCP server</th><th>Expires</th><th>Last seen</th><th>Comment</th></tr></thead><tbody>${sorted.length ? sorted.map(l => {
    const expiry = l.expiresAfter || (l.expiresInSec != null ? fmtDuration(l.expiresInSec) : '—');
    const status = l.status || (l.active ? 'bound' : 'unknown');
    return `<tr><td class="mono">${esc(l.address || '—')}</td><td>${esc(l.hostname || '—')}</td><td class="mono">${esc(l.mac || '—')}</td><td><span class="lease-status ${l.active ? 'active' : ''}">${esc(status)}</span></td><td>${esc(l.server || '—')}</td><td>${esc(expiry)}</td><td>${esc(l.lastSeen || '—')}</td><td>${esc(l.comment || '—')}</td></tr>`;
  }).join('') : '<tr><td colspan="8" class="table-empty">No DHCP leases reported by this device.</td></tr>'}</tbody></table></div>`;
}

function fmtRateKbps(v) {
  if (v == null || v === '') return '—';
  if (typeof v === 'string' && /[a-z]/i.test(v)) return v;
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return n >= 1000 ? `${(n / 1000).toFixed(1)} Mbps` : `${n.toFixed(0)} Kbps`;
}

function wifiTable(clients = []) {
  const sorted = [...clients].sort((a, b) => String(a.ssid || '').localeCompare(String(b.ssid || '')) || String(a.hostname || a.mac).localeCompare(String(b.hostname || b.mac)));
  return `<div class="table-wrap" data-client-table="wifi"><table><thead><tr><th>Client</th><th>IP address</th><th>MAC address</th><th>SSID</th><th>Interface</th><th>Signal</th><th>RX rate</th><th>TX rate</th><th>Traffic</th></tr></thead><tbody>${sorted.length ? sorted.map(c => {
    const rx = c.rxRate || fmtRateKbps(c.rxRateKbps);
    const tx = c.txRate || fmtRateKbps(c.txRateKbps);
    const traffic = c.rxBytes != null || c.txBytes != null ? `${fmtBytes(c.rxBytes)} ↓ / ${fmtBytes(c.txBytes)} ↑` : '—';
    return `<tr><td>${esc(c.hostname || '—')}</td><td class="mono">${esc(c.address || '—')}</td><td class="mono">${esc(c.mac || '—')}</td><td>${esc(c.ssid || '—')}</td><td class="mono">${esc(c.interface || '—')}</td><td>${c.signal == null ? '—' : `${esc(c.signal)} dBm`}</td><td>${esc(rx)}</td><td>${esc(tx)}</td><td>${esc(traffic)}</td></tr>`;
  }).join('') : '<tr><td colspan="9" class="table-empty">No associated Wi-Fi stations reported by this device.</td></tr>'}</tbody></table></div>`;
}

function neighborTable(neighbors = []) {
  const active = neighbors.filter(n => n.active);
  return `<div class="table-wrap" data-client-table="neighbors"><table><thead><tr><th>IP address</th><th>MAC address</th><th>Interface</th><th>Neighbor state</th></tr></thead><tbody>${active.length ? active.map(n => `<tr><td class="mono">${esc(n.address)}</td><td class="mono">${esc(n.mac)}</td><td class="mono">${esc(n.interface || '—')}</td><td>${esc(n.state || '—')}</td></tr>`).join('') : '<tr><td colspan="4" class="table-empty">No active network neighbors reported.</td></tr>'}</tbody></table></div>`;
}

function canManageInternetBlocks(d) {
  return Boolean(d && (d.osType === 'mikrotik' || (d.osType === 'openwrt' && d.deviceRole === 'client')));
}

function normalizedClientCandidates(live = {}) {
  const byMac = new Map();
  const add = (row = {}, source = '') => {
    const mac = String(row.mac || row['mac-address'] || '').trim().toUpperCase();
    if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) return;
    const current = byMac.get(mac) || { mac, hostname: '', address: '', source: '' };
    current.hostname ||= row.hostname || row.hostName || '';
    current.address ||= row.address || row.ip || '';
    current.source ||= source;
    byMac.set(mac, current);
  };
  (live.dhcpLeases || []).forEach(x => add(x, 'DHCP'));
  (live.wifiClients || []).forEach(x => add(x, 'Wi-Fi'));
  (live.neighbors || []).filter(x => x.active !== false).forEach(x => add(x, 'Neighbor'));
  return [...byMac.values()].sort((a,b)=>String(a.hostname || a.address || a.mac).localeCompare(String(b.hostname || b.address || b.mac), undefined, { numeric:true }));
}

function internetAccessSection(d, live = {}, blocks = [], error = '') {
  if (!canManageInternetBlocks(d)) return '';
  const blocked = new Set((Array.isArray(blocks) ? blocks : []).map(x => String(x.mac || x['src-mac-address'] || '').toUpperCase()).filter(Boolean));
  const candidates = normalizedClientCandidates(live);
  const rows = candidates.map(c => {
    const isBlocked = blocked.has(c.mac);
    return `<tr><td><b>${esc(c.hostname || 'Unknown client')}</b><small class="client-source">${esc(c.source || '')}</small></td><td class="mono">${esc(c.address || '—')}</td><td class="mono">${esc(c.mac)}</td><td><span class="access-state ${isBlocked ? 'blocked' : 'allowed'}">${isBlocked ? 'Blocked' : 'Allowed'}</span></td><td class="internet-action-cell"><button type="button" class="ghost internet-toggle ${isBlocked ? 'unblock' : 'block'}" data-mac="${esc(c.mac)}" data-action="${isBlocked ? 'unblock' : 'block'}">${isBlocked ? 'Unblock' : 'Block internet'}</button></td></tr>`;
  }).join('');
  const orphaned = [...blocked].filter(mac => !candidates.some(c => c.mac === mac));
  const orphanRows = orphaned.map(mac => `<tr><td><b>Blocked client</b><small class="client-source">Saved firewall rule</small></td><td class="mono">—</td><td class="mono">${esc(mac)}</td><td><span class="access-state blocked">Blocked</span></td><td class="internet-action-cell"><button type="button" class="ghost internet-toggle unblock" data-mac="${esc(mac)}" data-action="unblock">Unblock</button></td></tr>`).join('');
  return `<div class="section-head clients-subhead internet-access-head"><div><h2>Internet access</h2><p>Block or restore WAN access by client MAC address.</p></div></div>
    ${error ? `<div class="notice error-notice internet-block-error">${esc(error)}</div>` : ''}
    <form id="internet-block-form" class="card internet-block-form"><label>MAC address<input name="mac" class="mono" placeholder="AA:BB:CC:DD:EE:FF" required pattern="([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}" /></label><button type="submit" class="primary">Block internet</button><span id="internet-block-result" class="muted"></span></form>
    <div class="table-wrap" data-client-table="internet"><table><thead><tr><th>Client</th><th>IP address</th><th>MAC address</th><th>Internet</th><th></th></tr></thead><tbody>${rows || orphanRows ? rows + orphanRows : '<tr><td colspan="5" class="table-empty">No clients with a MAC address are currently visible.</td></tr>'}</tbody></table></div>`;
}

function ruijieClientsView(live = {}) {
  const clients = Array.isArray(live.neighbors) ? live.neighbors : (live.wifiClients || []);
  const sourceLabel = 'Ruijie Cloud';
  const rows = clients.map(c => `<tr><td><b>${esc(c.hostname || c.address || 'Unknown client')}</b><small class="client-source">${esc(c.manufacturer || c.os || sourceLabel)}</small></td><td class="mono">${esc(c.address || '—')}</td><td class="mono">${esc(c.mac || '—')}</td><td>${esc(c.interface || c.linkedDevice || '—')}</td><td>${c.rxBytes != null || c.txBytes != null ? `↓ ${fmtBytes(c.rxBytes || 0)} · ↑ ${fmtBytes(c.txBytes || 0)}` : '—'}</td><td>${c.uptimeSec != null ? fmtUptime(c.uptimeSec) : '—'}</td></tr>`).join('');
  return `<div class="section-head"><div><h2>Connected clients</h2><p>Clients reported by the Ruijie/Reyee Cloud project for this device.</p></div></div>
    <div class="table-wrap"><table><thead><tr><th>Client</th><th>IP address</th><th>MAC address</th><th>Port / uplink</th><th>Traffic</th><th>Uptime</th></tr></thead><tbody>${rows || `<tr><td colspan="6" class="table-empty">No clients are currently reported by ${esc(sourceLabel)}.</td></tr>`}</tbody></table></div>`;
}

function clientsView(live = {}, d = null, blocks = [], blockError = '') {
  if (d?.osType === 'ruijie') return ruijieClientsView(live);
  const wifi = live.wifiClients || [];
  const leases = live.dhcpLeases || [];
  const neighbors = live.neighbors || [];
  const collector = live.collector || {};
  const noDhcpNotice = !leases.length && neighbors.length
    ? '<div class="notice">This device has no local DHCP leases. It may be an access point or DHCP may be served by another router. Network neighbors are shown below as a fallback.</div>'
    : '';
  const sourceInfo = collector.api
    ? `Monitoring source: ${collector.api}${collector.wifiSource ? ` • Wi-Fi: ${collector.wifiSource}` : ''}`
    : `OpenWrt: ubus system ${collector.ubusSystem ? 'OK' : 'unavailable'} • board ${collector.ubusBoard ? 'OK' : 'unavailable'}`;
  return `<div class="section-head"><div><h2>Wireless clients</h2><p>Currently associated stations • ${esc(sourceInfo)}</p></div></div>
    ${wifiTable(wifi)}
    <div class="section-head clients-subhead"><div><h2>DHCP leases</h2><p>Addresses issued by this device</p></div></div>
    ${noDhcpNotice}${dhcpTable(leases)}
    ${!leases.length && neighbors.length ? `<div class="section-head clients-subhead"><div><h2>Network neighbors</h2><p>ARP/neighbor-table fallback; these are not necessarily DHCP leases</p></div></div>${neighborTable(neighbors)}` : ''}
    ${internetAccessSection(d, live, blocks, blockError)}`;
}

async function loadClientsTab(d, body, live = metricOf(d)) {
  let blocks = [];
  let error = '';
  if (canManageInternetBlocks(d)) {
    body.innerHTML = `${clientsView(live, d, state.routerData.internetBlocks || [])}<div class="client-block-loading skeleton sk-line"></div>`;
    try {
      blocks = await api(`/api/devices/${d.id}/internet-blocks`);
      state.routerData.internetBlocks = Array.isArray(blocks) ? blocks : [];
    } catch (err) {
      blocks = state.routerData.internetBlocks || [];
      error = err.message;
    }
  }
  body.innerHTML = clientsView(live, d, blocks, error);
  bindInternetBlockControls(d, body, live);
  void body.offsetWidth; body.classList.add('tab-enter');
}

function bindInternetBlockControls(d, body, live) {
  if (!canManageInternetBlocks(d)) return;
  const perform = async (action, mac, resultEl = null) => {
    if (resultEl) resultEl.textContent = action === 'block' ? 'Blocking…' : 'Restoring…';
    try {
      if (action === 'block') await api(`/api/devices/${d.id}/internet-blocks`, { method:'POST', body:JSON.stringify({ mac }) });
      else await api(`/api/devices/${d.id}/internet-blocks/${encodeURIComponent(mac)}`, { method:'DELETE' });
      await loadClientsTab(d, body, state.live.get(d.id) || live);
    } catch (err) {
      if (resultEl) resultEl.textContent = err.message;
      else alert(err.message);
    }
  };
  body.querySelectorAll('.internet-toggle').forEach(btn => btn.onclick = () => perform(btn.dataset.action, btn.dataset.mac));
  body.querySelector('#internet-block-form')?.addEventListener('submit', e => {
    e.preventDefault();
    const form = e.currentTarget;
    const mac = new FormData(form).get('mac');
    perform('block', String(mac || '').trim(), body.querySelector('#internet-block-result'));
  });
}


function portStatusLabel(status) {
  if (status === 'ready') return 'Ready';
  if (status === 'not-plugged') return 'Not plugged';
  if (status === 'disabled') return 'Disabled';
  if (status === 'enabled') return 'Enabled';
  return 'Inactive';
}

function physicalPortIcon(port = {}) {
  const kind = port.portKind === 'sfp' ? 'sfp' : 'ethernet';
  if (kind === 'sfp') return `<svg viewBox="0 0 64 48" aria-hidden="true"><rect x="8" y="10" width="48" height="28" rx="5"/><path d="M16 18h32v12H16zM24 34h16"/></svg>`;
  return `<svg viewBox="0 0 64 48" aria-hidden="true"><path d="M10 9h44v30H10z"/><path d="M19 9v8h26V9M18 31h28M22 31v8M42 31v8"/><path d="M23 21v5M29 21v5M35 21v5M41 21v5"/></svg>`;
}

function interfacesView(live = {}) {
  const all = Array.isArray(live.interfaces) ? live.interfaces : [];
  const natural = (a, b) => (Number(a.order ?? 9999) - Number(b.order ?? 9999)) || String(a.name).localeCompare(String(b.name), undefined, { numeric: true });
  const physical = all.filter(x => x.physical).sort(natural);
  const other = all.filter(x => !x.physical).sort(natural);
  const source = live.collector?.portSource;
  const portCards = physical.length ? physical.map(p => `<article class="port-card port-${esc(p.status || 'inactive')}">
      <div class="port-icon-shell ${esc(p.status || 'inactive')}">${physicalPortIcon(p)}<span class="port-led"></span></div>
      <div class="port-card-copy"><div class="port-card-title"><b>${esc(p.label || p.name)}</b><span class="port-state ${esc(p.status || 'inactive')}">${portStatusLabel(p.status)}</span></div>
      <div class="port-meta">${p.role ? `<span class="port-role ${esc(p.role)}">${esc(String(p.role).toUpperCase())}</span> • ` : ''}${esc(p.speed || (p.portKind === 'sfp' ? 'SFP' : 'Ethernet'))}${p.mac ? ` • <span class="mono">${esc(p.mac)}</span>` : ''}${p.vlan != null ? ` • VLAN ${esc(p.vlan)}` : ''}${p.vlanList ? ` • allowed ${esc(p.vlanList)}` : ''}</div>
      <div class="port-traffic"><span>↓ ${fmtBytes(p.rxBytes)}</span><span>↑ ${fmtBytes(p.txBytes)}</span>${p.duplex ? `<span>${esc(p.duplex)} duplex</span>` : ''}${p.poeStatus ? `<span>PoE ${esc(p.poeStatus)}${p.powerUsed ? ` · ${esc(p.powerUsed)}` : ''}</span>` : ''}${p.loopState ? `<span>Loop ${esc(p.loopState)}</span>` : ''}${p.linkDowns != null ? `<span>${esc(p.linkDowns)} link down${Number(p.linkDowns) === 1 ? '' : 's'}</span>` : ''}</div></div>
    </article>`).join('') : '<div class="empty port-empty">No built-in Ethernet/SFP ports were reported by this device.</div>';
  const otherTable = other.length ? `<div class="section-head clients-subhead"><div><h2>Other interfaces</h2><p>Bridge, VLAN, tunnel and wireless runtime interfaces</p></div></div><div class="table-wrap"><table><thead><tr><th>Name</th><th>Type</th><th>Status</th><th>MAC</th><th>MTU</th><th>Traffic</th></tr></thead><tbody>${other.map(p => `<tr><td class="mono">${esc(p.name)}</td><td>${esc(p.type || 'interface')}</td><td><span class="port-state ${esc(p.status || 'inactive')}">${portStatusLabel(p.status)}</span></td><td class="mono">${esc(p.mac || '—')}</td><td>${esc(p.mtu ?? '—')}</td><td>${fmtBytes(p.rxBytes)} ↓ / ${fmtBytes(p.txBytes)} ↑</td></tr>`).join('')}</tbody></table></div>` : '';
  const subtitle = source ? `Port discovery: ${source} • live carrier/speed/stats from the device` : 'Physical port state updates with live device polling.';
  return `<div class="section-head"><div><h2>Port status</h2><p>${esc(subtitle)}</p></div></div><div class="port-grid">${portCards}</div>${otherTable}`;
}

function wirelessState(status) {
  if (status === 'ready') return 'Broadcasting';
  if (status === 'disabled') return 'Disabled';
  if (status === 'enabled') return 'Enabled';
  return 'Inactive';
}

function encryptionOptions(current = '') {
  const common = ['none', 'psk2', 'psk-mixed', 'sae', 'sae-mixed'];
  const values = current && !common.includes(current) ? [current, ...common] : common;
  return values.map(v => `<option value="${esc(v)}" ${v === current ? 'selected' : ''}>${esc(v)}</option>`).join('');
}

function wirelessView(d, data = { interfaces: [] }, error = '') {
  const rows = Array.isArray(data.interfaces) ? data.interfaces : [];
  if (error) return `${managementError(error)}<button type="button" class="ghost" id="wireless-reload">Try again</button>`;
  return `<div class="section-head"><div><h2>Wireless</h2><p>View SSID status and update existing wireless interfaces. Password fields are write-only and never reveal the current key.</p></div><button type="button" class="ghost" id="wireless-reload">Refresh</button></div>
    <div class="wireless-grid">${rows.length ? rows.map(w => {
      const modernMikroTik = d.osType === 'mikrotik' && w.source === 'wifi';
      const legacyMikroTik = d.osType === 'mikrotik' && w.source === 'wireless';
      return `<form class="card wireless-card" data-wireless-id="${esc(w.id || w.section || w.name)}" data-source="${esc(w.source || data.source || '')}" data-radio="${esc(w.radio || '')}">
        <div class="wireless-card-head"><div class="wifi-symbol ${esc(w.status || 'inactive')}"><svg viewBox="0 0 48 48" aria-hidden="true"><path d="M7 18c10-9 24-9 34 0M13 25c7-6 15-6 22 0M19 32c3-3 7-3 10 0"/><circle cx="24" cy="38" r="2.5"/></svg></div><div><h3>${esc(w.ssid || '(SSID not set)')}</h3><p>${esc(w.name || w.ifname || w.section || 'wireless')} ${w.radio ? `• ${esc(w.radio)}` : ''}</p></div><span class="wireless-state ${esc(w.status || 'inactive')}">${wirelessState(w.status)}</span></div>
        <div class="wireless-facts"><span><small>Mode</small><b>${esc(w.mode || '—')}</b></span><span><small>Band</small><b>${esc(w.band || '—')}</b></span><span><small>${d.osType === 'mikrotik' ? 'Frequency' : 'Channel'}</small><b>${esc((d.osType === 'mikrotik' ? w.frequency : w.channel) || 'auto')}</b></span><span><small>Security</small><b>${esc(w.authentication || w.encryption || w.securityProfile || '—')}</b></span><span><small>Interface</small><b>${esc(w.ifname || w.name || '—')}</b></span><span><small>Clients</small><b>${(state.live.get(d.id)?.wifiClients || []).filter(c => (c.ssid && c.ssid === w.ssid) || (c.interface && [w.name,w.ifname].includes(c.interface))).length}</b></span></div>
        ${w.dynamic ? '<div class="notice compact-notice">This is a dynamic/CAPsMAN-managed interface and may reject direct edits.</div>' : `<div class="wireless-edit-grid">
          <label class="span2">SSID<input name="ssid" maxlength="32" required value="${esc(w.ssid || '')}" /></label>
          ${d.osType === 'openwrt' ? `<label>Encryption<select name="encryption">${encryptionOptions(w.encryption || 'none')}</select></label><label>Channel<input name="channel" value="${esc(w.channel || '')}" placeholder="auto / 36" /></label>` : `<label>Frequency<input name="frequency" value="${esc(w.frequency || '')}" placeholder="auto / 5180 / 5490-5730" /></label>${modernMikroTik ? `<label>Authentication types<input name="authentication" value="${esc(w.authentication || '')}" placeholder="wpa2-psk,wpa3-psk" /></label>` : '<div></div>'}`}
          ${d.osType === 'openwrt' || modernMikroTik ? `<label class="span2">New Wi-Fi password <span class="muted">(leave blank to keep current)</span><input name="passphrase" type="password" autocomplete="new-password" minlength="8" maxlength="63" /></label>` : ''}
          <label class="check"><input type="checkbox" name="enabled" ${w.disabled ? '' : 'checked'} /> Enabled</label>
          <label class="check"><input type="checkbox" name="hidden" ${w.hidden ? 'checked' : ''} /> Hidden SSID</label>
          ${d.osType === 'openwrt' ? `<label class="check"><input type="checkbox" name="isolate" ${w.isolate ? 'checked' : ''} /> Client isolation</label>` : ''}
          ${legacyMikroTik ? `<div class="muted span2">Legacy RouterOS wireless security uses security profiles; RouterDeck changes SSID/status/frequency here without exposing profile secrets.</div>` : ''}
        </div><div class="wireless-card-actions"><span class="wireless-result muted"></span><button type="submit" class="primary">Apply wireless</button></div>`}
      </form>`;
    }).join('') : '<div class="empty">No wireless interfaces were found on this device.</div>'}</div>`;
}

async function loadWirelessTab(d, body) {
  body.innerHTML = '<div class="wireless-grid"><div class="card skeleton-panel"><div class="skeleton sk-line"></div><div class="skeleton sk-line"></div><div class="skeleton sk-line"></div></div><div class="card skeleton-panel"><div class="skeleton sk-line"></div><div class="skeleton sk-line"></div><div class="skeleton sk-line"></div></div></div>';
  let data = { interfaces: [] }, error = '';
  try { data = await api(`/api/devices/${d.id}/wireless`); } catch (e) { error = e.message; }
  if (state.deviceTab !== 'wireless') return;
  state.routerData.wireless = data.interfaces || [];
  body.innerHTML = wirelessView(d, data, error);
  body.classList.add('tab-enter');
  $('#wireless-reload')?.addEventListener('click', () => loadWirelessTab(d, body));
  $$('.wireless-card').forEach(form => form.addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(form);
    const id = form.dataset.wirelessId;
    const source = form.dataset.source;
    const result = form.querySelector('.wireless-result');
    const payload = {
      source,
      radio: form.dataset.radio || undefined,
      ssid: f.get('ssid'),
      disabled: !f.has('enabled'),
      hidden: f.has('hidden'),
      ...(d.osType === 'openwrt' ? { isolate: f.has('isolate'), encryption: f.get('encryption'), channel: f.get('channel') } : { frequency: f.get('frequency'), authentication: f.get('authentication') }),
      passphrase: f.get('passphrase') || undefined,
    };
    try {
      if (result) result.textContent = 'Applying…';
      await api(`/api/devices/${d.id}/wireless/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      if (result) result.textContent = 'Applied. Reloading radio status…';
      await new Promise(resolve => setTimeout(resolve, d.osType === 'openwrt' ? 1800 : 600));
      await loadWirelessTab(d, body);
    } catch (err) { if (result) result.textContent = err.message; }
  }));
}

function tableBool(v) { return v === true || v === 'true' || v === 'yes'; }
function managementError(err) { return `<div class="notice error-notice">${esc(err?.message || err || 'Request failed')}</div>`; }
function miniAction(label, action, id, extra = '') { return `<button type="button" class="mini-action ${extra}" data-action="${action}" data-id="${esc(id || '')}">${esc(label)}</button>`; }

function queueView(rows = [], kind = 'simple', error = '') {
  return `${error ? managementError(error) : ''}<div class="firewall-toolbar card"><label>Queue type<select id="queue-kind"><option value="simple" ${kind==='simple'?'selected':''}>Simple Queue</option><option value="tree" ${kind==='tree'?'selected':''}>Queue Tree</option></select></label><div class="muted">RouterOS /queue ${kind} • ${rows.length} entries</div></div><div class="manage-layout">
    <form id="queue-form" class="card manage-form">
      <div class="section-head compact"><div><h2 id="queue-form-title">Add ${kind === 'tree' ? 'queue tree' : 'simple queue'}</h2><p>RouterOS /queue ${kind}</p></div><button type="button" id="queue-cancel-edit" class="ghost hidden">Cancel edit</button></div>
      <input type="hidden" name="id" />
      <div class="manage-grid">
        <label>Name<input name="name" required placeholder="client-limit" /></label>
        <label>Target ${kind === 'tree' ? '(simple only)' : ''}<input name="target" ${kind === 'simple' ? 'required' : ''} placeholder="10.10.10.20/32" /></label>
        <label>Max limit<input name="maxLimit" placeholder="20M/100M" /></label>
        <label>Limit at<input name="limitAt" placeholder="0/0" /></label>
        <label>Priority<input name="priority" placeholder="8/8" /></label>
        <label>Queue type<input name="queue" placeholder="default-small/default-small" /></label>
        <label>Parent<input name="parent" placeholder="${kind === 'tree' ? 'global / interface / queue' : 'none'}" /></label>
        <label>Packet marks<input name="packetMarks" placeholder="game-packet" /></label>
        <label class="span2">Comment<input name="comment" placeholder="Managed by RouterDeck" /></label>
        <label class="check span2"><input name="disabled" type="checkbox" /> Disabled</label>
      </div>
      <div class="manage-form-actions"><span id="queue-result" class="muted"></span><button type="submit" class="primary">Apply queue</button></div>
    </form>
    <div class="manage-main"><div class="section-head compact"><div><h2>${kind === 'tree' ? 'Queue tree' : 'Simple queues'}</h2><p>${rows.length} entries • dynamic entries are read-only</p></div><button type="button" class="ghost" id="queue-reload">Refresh</button></div>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>${kind === 'tree' ? 'Parent' : 'Target'}</th><th>Packet mark</th><th>Max limit</th><th>Current rate</th><th>Priority</th><th>Queue</th><th>Comment</th><th>State</th><th>Actions</th></tr></thead><tbody>${rows.length ? rows.map(r => {
        const id = r['.id'] || '';
        const dynamic = tableBool(r.dynamic);
        const disabled = tableBool(r.disabled);
        return `<tr><td><b>${esc(r.name || '—')}</b></td><td class="mono">${esc(kind === 'tree' ? (r.parent || '—') : (r.target || '—'))}</td><td>${esc(r['packet-marks'] || r['packet-mark'] || '—')}</td><td>${esc(r['max-limit'] || '—')}</td><td>${esc(r.rate || '—')}</td><td>${esc(r.priority || '—')}</td><td>${esc(r.queue || '—')}</td><td>${esc(r.comment || '—')}</td><td><span class="lease-status ${!disabled ? 'active' : ''}">${dynamic ? 'dynamic' : disabled ? 'disabled' : 'enabled'}</span></td><td><div class="row-actions">${dynamic ? '<span class="muted">read-only</span>' : `${miniAction('Edit','edit-queue',id)}${miniAction(disabled ? 'Enable' : 'Disable','toggle-queue',id)}${miniAction('Delete','delete-queue',id,'danger')}`}</div></td></tr>`;
      }).join('') : `<tr><td colspan="10" class="table-empty">No ${kind === 'tree' ? 'queue tree entries' : 'simple queues'} configured.</td></tr>`}</tbody></table></div>
    </div></div>`;
}

function queuePayloadFromForm(form) {
  const f = new FormData(form);
  return {
    name: f.get('name'), target: f.get('target'), 'max-limit': f.get('maxLimit'),
    'limit-at': f.get('limitAt'), priority: f.get('priority'), queue: f.get('queue'),
    parent: f.get('parent'), ...(state.routerData.queueKind === 'tree' ? {'packet-mark': f.get('packetMarks')} : {'packet-marks': f.get('packetMarks')}), comment: f.get('comment'), disabled: f.has('disabled'),
  };
}
function populateQueueForm(row = null) {
  const form = $('#queue-form'); if (!form) return;
  const set = (name, value) => { if (form.elements[name]) form.elements[name].value = value || ''; };
  set('id', row?.['.id']); set('name', row?.name); set('target', row?.target); set('maxLimit', row?.['max-limit']);
  set('limitAt', row?.['limit-at']); set('priority', row?.priority); set('queue', row?.queue); set('parent', row?.parent); set('packetMarks', row?.['packet-marks'] || row?.['packet-mark']); set('comment', row?.comment);
  form.elements.disabled.checked = tableBool(row?.disabled);
  $('#queue-form-title').textContent = row ? `Edit ${row.name || 'queue'}` : `Add ${state.routerData.queueKind === 'tree' ? 'queue tree' : 'simple queue'}`;
  $('#queue-cancel-edit').classList.toggle('hidden', !row);
}
async function loadQueueTab(d, body, kind = state.routerData.queueKind || 'simple') {
  state.routerData.queueKind = kind;
  body.innerHTML = '<div class="card skeleton-panel"><div class="skeleton sk-line"></div><div class="skeleton sk-line"></div><div class="skeleton sk-line"></div></div>';
  let rows = [], error = '';
  try { rows = await api(`/api/devices/${d.id}/mikrotik/queues?kind=${encodeURIComponent(kind)}`); } catch (e) { error = e.message; }
  state.routerData.queues = rows;
  if (state.deviceTab !== 'queues') return;
  body.innerHTML = queueView(rows, kind, error); body.classList.add('tab-enter');
  $('#queue-kind')?.addEventListener('change', e => loadQueueTab(d, body, e.target.value));
  $('#queue-reload')?.addEventListener('click', () => loadQueueTab(d, body, kind));
  $('#queue-cancel-edit')?.addEventListener('click', () => populateQueueForm());
  $('#queue-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const id = e.currentTarget.elements.id.value;
    const result = $('#queue-result'); result.textContent = 'Applying…';
    try {
      await api(id ? `/api/devices/${d.id}/mikrotik/queues/${encodeURIComponent(id)}` : `/api/devices/${d.id}/mikrotik/queues`, { method: id ? 'PATCH' : 'POST', body: JSON.stringify({ kind, ...queuePayloadFromForm(e.currentTarget) }) });
      await loadQueueTab(d, body, kind);
    } catch (err) { result.textContent = err.message; }
  });
  $$('[data-action="edit-queue"]').forEach(btn => btn.onclick = () => populateQueueForm(rows.find(x => x['.id'] === btn.dataset.id)));
  $$('[data-action="toggle-queue"]').forEach(btn => btn.onclick = async () => {
    const row = rows.find(x => x['.id'] === btn.dataset.id); if (!row) return;
    await api(`/api/devices/${d.id}/mikrotik/queues/${encodeURIComponent(btn.dataset.id)}`, { method: 'PATCH', body: JSON.stringify({ kind, disabled: !tableBool(row.disabled) }) });
    await loadQueueTab(d, body, kind);
  });
  $$('[data-action="delete-queue"]').forEach(btn => btn.onclick = async () => {
    const row = rows.find(x => x['.id'] === btn.dataset.id); if (!confirm(`Delete queue ${row?.name || btn.dataset.id}?`)) return;
    await api(`/api/devices/${d.id}/mikrotik/queues/${encodeURIComponent(btn.dataset.id)}?kind=${encodeURIComponent(kind)}`, { method: 'DELETE' });
    await loadQueueTab(d, body, kind);
  });
}

function firewallMatcher(r) {
  return [r.protocol, r['src-address'], r['dst-address'], r['src-port'] ? `sport:${r['src-port']}` : '', r['dst-port'] ? `dport:${r['dst-port']}` : '', r['in-interface'] ? `in:${r['in-interface']}` : '', r['out-interface'] ? `out:${r['out-interface']}` : '', r['src-address-list'] ? `src-list:${r['src-address-list']}` : '', r['dst-address-list'] ? `dst-list:${r['dst-address-list']}` : ''].filter(Boolean).join(' • ') || 'any';
}
function firewallView(rows = [], table = 'filter', error = '') {
  return `${error ? managementError(error) : ''}<div class="firewall-toolbar card"><label>Firewall table<select id="firewall-table"><option value="filter" ${table==='filter'?'selected':''}>Filter</option><option value="nat" ${table==='nat'?'selected':''}>NAT</option><option value="mangle" ${table==='mangle'?'selected':''}>Mangle</option><option value="raw" ${table==='raw'?'selected':''}>Raw</option></select></label><div class="muted">RouterOS REST • ${rows.length} rules</div></div>
  <div class="manage-layout firewall-layout">
    <form id="firewall-form" class="card manage-form">
      <div class="section-head compact"><div><h2 id="firewall-form-title">Add ${esc(table)} rule</h2><p>Common matchers/actions</p></div><button type="button" id="firewall-cancel-edit" class="ghost hidden">Cancel edit</button></div>
      <input type="hidden" name="id" />
      <div class="manage-grid">
        <label>Chain<input name="chain" required placeholder="forward" /></label><label>Action<input name="action" required placeholder="accept / drop" /></label>
        <label>Protocol<input name="protocol" placeholder="tcp / udp / icmp" /></label><label>Source address<input name="srcAddress" placeholder="10.0.0.0/24" /></label>
        <label>Destination address<input name="dstAddress" placeholder="0.0.0.0/0" /></label><label>Source port<input name="srcPort" placeholder="53 / 1000-2000" /></label>
        <label>Destination port<input name="dstPort" placeholder="80,443" /></label><label>In interface<input name="inInterface" placeholder="ether1" /></label>
        <label>Out interface<input name="outInterface" placeholder="pppoe-main" /></label><label>Source address list<input name="srcAddressList" /></label>
        <label>Destination address list<input name="dstAddressList" /></label><label>To addresses (NAT)<input name="toAddresses" /></label>
        <label>To ports (NAT)<input name="toPorts" /></label><label>New packet mark (mangle)<input name="newPacketMark" /></label>
        <label class="span2">Comment<input name="comment" placeholder="Managed by RouterDeck" /></label>
        <label class="check"><input name="log" type="checkbox" /> Log matches</label><label class="check"><input name="disabled" type="checkbox" /> Disabled</label>
      </div>
      <div class="notice compact-notice">Firewall changes apply immediately. Keep an allow rule for RouterDeck management traffic before adding restrictive input rules.</div>
      <div class="manage-form-actions"><span id="firewall-result" class="muted"></span><button type="submit" class="primary">Apply rule</button></div>
    </form>
    <div class="manage-main"><div class="section-head compact"><div><h2>${esc(table)} rules</h2><p>Dynamic rules are read-only</p></div><button type="button" class="ghost" id="firewall-reload">Refresh</button></div>
      <div class="table-wrap"><table><thead><tr><th>Chain</th><th>Action</th><th>Matchers</th><th>Packets</th><th>Bytes</th><th>Comment</th><th>State</th><th>Actions</th></tr></thead><tbody>${rows.length ? rows.map(r => {
        const id = r['.id'] || ''; const dynamic = tableBool(r.dynamic); const disabled = tableBool(r.disabled);
        return `<tr><td>${esc(r.chain || '—')}</td><td><b>${esc(r.action || '—')}</b></td><td class="matcher-cell">${esc(firewallMatcher(r))}</td><td>${esc(r.packets || '0')}</td><td>${fmtBytes(r.bytes)}</td><td>${esc(r.comment || '—')}</td><td><span class="lease-status ${!disabled ? 'active' : ''}">${dynamic ? 'dynamic' : disabled ? 'disabled' : 'enabled'}</span></td><td><div class="row-actions">${dynamic ? '<span class="muted">read-only</span>' : `${miniAction('Edit','edit-fw',id)}${miniAction(disabled ? 'Enable':'Disable','toggle-fw',id)}${miniAction('Delete','delete-fw',id,'danger')}`}</div></td></tr>`;
      }).join('') : '<tr><td colspan="8" class="table-empty">No firewall rules in this table.</td></tr>'}</tbody></table></div>
    </div></div>`;
}
function firewallPayloadFromForm(form, table) {
  const f = new FormData(form); const payload = { table, chain:f.get('chain'), action:f.get('action'), protocol:f.get('protocol'), 'src-address':f.get('srcAddress'), 'dst-address':f.get('dstAddress'), 'src-port':f.get('srcPort'), 'dst-port':f.get('dstPort'), 'in-interface':f.get('inInterface'), 'out-interface':f.get('outInterface'), 'src-address-list':f.get('srcAddressList'), 'dst-address-list':f.get('dstAddressList'), 'to-addresses':f.get('toAddresses'), 'to-ports':f.get('toPorts'), 'new-packet-mark':f.get('newPacketMark'), comment:f.get('comment'), log:f.has('log'), disabled:f.has('disabled') };
  return payload;
}
function populateFirewallForm(row = null) {
  const form = $('#firewall-form'); if (!form) return;
  const map = {chain:'chain',action:'action',protocol:'protocol',srcAddress:'src-address',dstAddress:'dst-address',srcPort:'src-port',dstPort:'dst-port',inInterface:'in-interface',outInterface:'out-interface',srcAddressList:'src-address-list',dstAddressList:'dst-address-list',toAddresses:'to-addresses',toPorts:'to-ports',newPacketMark:'new-packet-mark',comment:'comment'};
  form.elements.id.value = row?.['.id'] || '';
  for (const [field,key] of Object.entries(map)) if (form.elements[field]) form.elements[field].value = row?.[key] || '';
  form.elements.log.checked = tableBool(row?.log); form.elements.disabled.checked = tableBool(row?.disabled);
  $('#firewall-form-title').textContent = row ? `Edit ${state.routerData.firewallTable} rule` : `Add ${state.routerData.firewallTable} rule`;
  $('#firewall-cancel-edit').classList.toggle('hidden', !row);
}
async function loadFirewallTab(d, body, table = state.routerData.firewallTable || 'filter') {
  state.routerData.firewallTable = table;
  body.innerHTML = '<div class="card skeleton-panel"><div class="skeleton sk-line"></div><div class="skeleton sk-line"></div><div class="skeleton sk-line"></div></div>';
  let rows = [], error = '';
  try { rows = await api(`/api/devices/${d.id}/mikrotik/firewall?table=${encodeURIComponent(table)}`); } catch (e) { error = e.message; }
  state.routerData.firewall = rows;
  if (state.deviceTab !== 'firewall') return;
  body.innerHTML = firewallView(rows, table, error); body.classList.add('tab-enter');
  $('#firewall-table')?.addEventListener('change', e => loadFirewallTab(d, body, e.target.value));
  $('#firewall-reload')?.addEventListener('click', () => loadFirewallTab(d, body, table));
  $('#firewall-cancel-edit')?.addEventListener('click', () => populateFirewallForm());
  $('#firewall-form')?.addEventListener('submit', async e => {
    e.preventDefault(); const id = e.currentTarget.elements.id.value;
    if (!confirm(`Apply this ${table} firewall change now? A bad rule can interrupt management access.`)) return;
    const result = $('#firewall-result'); result.textContent = 'Applying…';
    try {
      await api(id ? `/api/devices/${d.id}/mikrotik/firewall/${encodeURIComponent(id)}` : `/api/devices/${d.id}/mikrotik/firewall`, { method:id?'PATCH':'POST', body:JSON.stringify(firewallPayloadFromForm(e.currentTarget, table)) });
      await loadFirewallTab(d, body, table);
    } catch (err) { result.textContent = err.message; }
  });
  $$('[data-action="edit-fw"]').forEach(btn => btn.onclick = () => populateFirewallForm(rows.find(x => x['.id'] === btn.dataset.id)));
  $$('[data-action="toggle-fw"]').forEach(btn => btn.onclick = async () => {
    const row = rows.find(x => x['.id'] === btn.dataset.id); if (!row) return;
    await api(`/api/devices/${d.id}/mikrotik/firewall/${encodeURIComponent(btn.dataset.id)}`, { method:'PATCH', body:JSON.stringify({ table, disabled:!tableBool(row.disabled) }) });
    await loadFirewallTab(d, body, table);
  });
  $$('[data-action="delete-fw"]').forEach(btn => btn.onclick = async () => {
    const row = rows.find(x => x['.id'] === btn.dataset.id); if (!confirm(`Delete ${table} rule ${row?.comment || row?.chain || btn.dataset.id}?`)) return;
    await api(`/api/devices/${d.id}/mikrotik/firewall/${encodeURIComponent(btn.dataset.id)}?table=${encodeURIComponent(table)}`, { method:'DELETE' });
    await loadFirewallTab(d, body, table);
  });
}

function logsView(rows = [], error = '') {
  return `${error ? managementError(error) : ''}<div class="section-head"><div><h2>Device logs</h2><p>Newest entries first</p></div><div class="log-tools"><input id="log-search" placeholder="Filter logs…"/><button type="button" class="ghost" id="logs-reload">Refresh</button></div></div><div id="log-list" class="log-list">${rows.length ? rows.map(r => `<div class="log-row" data-log-text="${esc(`${r.time} ${r.topics} ${r.message}`).toLowerCase()}"><span class="log-time">${esc(r.time || '—')}</span><span class="log-topic">${esc(r.topics || 'system')}</span><span class="log-message">${esc(r.message || '')}</span></div>`).join('') : '<div class="empty">No log entries returned.</div>'}</div>`;
}
async function loadLogsTab(d, body) {
  body.innerHTML = '<div class="card skeleton-panel"><div class="skeleton sk-line"></div><div class="skeleton sk-line"></div><div class="skeleton sk-line"></div></div>';
  let rows = [], error = '';
  try { rows = await api(`/api/devices/${d.id}/logs?limit=300`); } catch (e) { error = e.message; }
  state.routerData.logs = rows;
  if (state.deviceTab !== 'logs') return;
  body.innerHTML = logsView(rows, error); body.classList.add('tab-enter');
  $('#logs-reload')?.addEventListener('click', () => loadLogsTab(d, body));
  $('#log-search')?.addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    $$('.log-row').forEach(row => row.classList.toggle('hidden', q && !row.dataset.logText.includes(q)));
  });
}

function deviceSkeleton() {
  return `<div class="detail-head"><div class="skeleton sk-line sk-short"></div><div class="skeleton sk-button"></div></div>
    <div class="cards skeleton-cards">${Array.from({ length: 4 }, () => '<div class="card"><div class="skeleton sk-line sk-small"></div><div class="skeleton sk-value"></div></div>').join('')}</div>
    <div class="tabs skeleton-tabs">${Array.from({ length: 8 }, () => '<div class="skeleton sk-tab"></div>').join('')}</div>
    <div class="overview-grid"><div class="card skeleton-panel">${Array.from({ length: 7 }, () => '<div class="skeleton sk-line"></div>').join('')}</div><div class="card skeleton-panel">${Array.from({ length: 4 }, () => '<div class="skeleton sk-line"></div>').join('')}</div></div>`;
}
function uptimeSkeleton() {
  return `<div class="status-admin-grid"><div class="card skeleton-panel">${Array.from({ length: 5 }, () => '<div class="skeleton sk-line"></div>').join('')}</div><div class="card skeleton-panel"><div class="skeleton sk-value"></div><div class="skeleton sk-line"></div></div></div><div class="card skeleton-panel uptime-skeleton">${Array.from({ length: 4 }, () => '<div class="skeleton sk-line"></div>').join('')}</div>`;
}

function bindDetailActions(d) {
  $('#edit-device')?.addEventListener('click', () => openEditDialog('device', d.id));
  $('#back').onclick = () => {
    cleanupTerminal();
    cleanupAnalyticsTimer();
    const returnPage = ['dashboard','topology'].includes(state.deviceReturnPage) ? state.deviceReturnPage : 'devices';
    state.page = returnPage;
    state.selected = null;
    state.deviceTab = 'overview';
    if (returnPage === 'dashboard') renderDashboard(true);
    else if (returnPage === 'topology') renderTopology(true);
    else renderDevices(true);
  };
  $('#delete-device').onclick = async () => {
    if (!confirm(`Delete ${d.name}?`)) return;
    cleanupTerminal();
    cleanupAnalyticsTimer();
    await api(`/api/devices/${d.id}`, { method: 'DELETE' });
    await refreshDevices();
    const returnPage = ['dashboard','topology'].includes(state.deviceReturnPage) ? state.deviceReturnPage : 'devices';
    state.page = returnPage;
    state.selected = null;
    state.deviceTab = 'overview';
    if (returnPage === 'dashboard') renderDashboard(true);
    else if (returnPage === 'topology') renderTopology(true);
    else renderDevices(true);
  };
}

function serviceSkeleton() {
  return `<div class="detail-head"><div class="skeleton sk-line sk-short"></div><div class="skeleton sk-button"></div></div>
    <div class="cards skeleton-cards">${Array.from({length:4},()=>'<div class="card"><div class="skeleton sk-line sk-small"></div><div class="skeleton sk-value"></div></div>').join('')}</div>
    <div class="tabs skeleton-tabs">${Array.from({length:3},()=>'<div class="skeleton sk-tab"></div>').join('')}</div><div class="card skeleton-panel tall"></div>`;
}

function bindServiceDetailActions(service) {
  $('#edit-service')?.addEventListener('click', () => openEditDialog('service', service.id));
  $('#back-service')?.addEventListener('click',()=>{ const returnPage=state.serviceReturnPage==='dashboard'?'dashboard':'devices'; state.page=returnPage; state.selectedService=null; state.serviceTab='overview'; if(returnPage==='dashboard') renderDashboard(true); else renderDevices(true); });
  $('#delete-service')?.addEventListener('click',async()=>{ if(!confirm(`Delete ${service.name}?`)) return; await api(`/api/services/${service.id}`,{method:'DELETE'}); await refreshServices(); const returnPage=state.serviceReturnPage==='dashboard'?'dashboard':'devices'; state.page=returnPage; state.selectedService=null; state.serviceTab='overview'; if(returnPage==='dashboard') renderDashboard(true); else renderDevices(true); });
}

function serviceOpenLink(service, label = 'Open web UI') {
  return `<a class="ghost link-button button-with-icon" href="${esc(serviceWebUrl(service))}" target="_blank" rel="noopener">${label} ↗</a>`;
}

function adguardOverview(service, live = {}) {
  const m=live||{}; const stats=m.stats||{}; const online=Number(m.status)===1;
  const memPct=serviceMemoryPercent(m);
  const blocked=Number(stats.numBlockedFiltering||0); const queries=Number(stats.numDnsQueries||0);
  const blockedPct=queries?blocked/queries*100:0;
  return `<div class="cards service-summary-cards">
    <div class="card"><div class="stat-label">Status</div><div class="stat-value status-text ${online?'up':'down'}" data-service-live="status">${online?'On':'Off'}</div></div>
    <div class="card"><div class="stat-label">CPU</div><div class="stat-value" data-service-live="cpu">${fmtPct(m.cpu)}</div></div>
    <div class="card"><div class="stat-label">Memory</div><div class="stat-value" data-service-live="memory">${fmtPct(memPct)}</div><small data-service-live="memory-note">${m.memoryUsed?fmtBytes(m.memoryUsed):'SSH metrics optional'}</small></div>
    <div class="card"><div class="stat-label">DNS protection</div><div class="stat-value smaller" data-service-live="protection">${m.protectionEnabled?'Enabled':'Disabled'}</div></div>
  </div>
  <div class="overview-grid">
    <div class="card info-card"><div class="section-head compact"><div class="section-title-with-logo">${serviceIcon('adguardhome','detail-os-logo')}<div><h2>AdGuard Home</h2><p>DNS service information</p></div></div>${serviceOpenLink(service,'Open AdGuard Home')}</div><div class="info-grid">
      ${infoItem('Service name',service.name)}${infoItem('Version',m.version||'—')}${infoItem('API endpoint',serviceWebUrl(service),true)}${infoItem('DNS port',m.dnsPort||'—')}${infoItem('DNS addresses',(m.dnsAddresses||[]).join(', ')||'—',true)}${infoItem('Host control',service.sshMetrics?(m.processFound===false?'AdGuardHome process not found':'SSH enabled'):'Not configured')}
    </div></div>
    <div class="card"><div class="section-head compact"><div><h2>DNS activity</h2><p>Current AdGuard Home statistics window</p></div></div><div class="traffic-values"><div><span>DNS queries</span><b data-service-live="queries">${queries.toLocaleString()}</b></div><div><span>Blocked</span><b data-service-live="blocked">${blocked.toLocaleString()} · ${blockedPct.toFixed(1)}%</b></div><div><span>Average response</span><b data-service-live="response">${stats.avgProcessingTime==null?'—':`${(Number(stats.avgProcessingTime)*1000).toFixed(2)} ms`}</b></div><div><span>Protection</span><b data-service-live="protection-short">${m.protectionEnabled?'On':'Off'}</b></div></div></div>
  </div>
  <div class="service-actions card"><div><h3>Service controls</h3><p>${service.sshMetrics?'Start/stop controls use the configured SSH host account. ':''}DNS protection and cache controls use the AdGuard Home API.</p></div><div class="service-action-buttons">${serviceOpenLink(service,'Open page')}${service.sshMetrics?`<button type="button" class="ghost ${online?'danger':''}" id="adguard-process">${online?'Stop service':'Start service'}</button>`:''}<button type="button" class="ghost" id="adguard-cache-clear">Clear DNS cache</button><button type="button" class="primary" id="adguard-protection">${m.protectionEnabled?'Disable protection':'Enable protection'}</button></div><span id="service-action-result" class="muted"></span></div>`;
}

function homeAssistantRoomsSection(rooms = []) {
  const list = Array.isArray(rooms) ? rooms : [];
  return `<div class="card ha-rooms-section"><div class="section-head compact"><div><h2>Rooms</h2><p>Home Assistant areas with their current entity and device counts</p></div><span class="room-total">${list.length} room${list.length === 1 ? '' : 's'}</span></div>
    <div class="ha-room-grid">${list.length ? list.map(room => `<article class="ha-room-card"><div class="ha-room-icon">${heroIcon('chevron')}</div><div class="ha-room-copy"><b>${esc(room.name || 'Unnamed room')}</b><span>${Number(room.entityCount || 0).toLocaleString()} entities · ${Number(room.deviceCount || 0).toLocaleString()} devices</span></div><div class="ha-room-state"><strong>${Number(room.activeCount || 0).toLocaleString()}</strong><small>active</small></div></article>`).join('') : '<div class="empty compact-empty">No Home Assistant rooms/areas were returned for this token.</div>'}</div></div>`;
}

function homeAssistantOverview(service, live = {}) {
  const m=live||{}; const online=Number(m.status)===1;
  return `<div class="cards service-summary-cards">
    <div class="card"><div class="stat-label">Status</div><div class="stat-value status-text ${online?'up':'down'}" data-service-live="status">${online?'Online':'Offline'}</div></div>
    <div class="card"><div class="stat-label">Entities</div><div class="stat-value" data-service-live="entities">${Number(m.entityCount||0).toLocaleString()}</div></div>
    <div class="card"><div class="stat-label">Rooms</div><div class="stat-value" data-service-live="rooms">${Number(m.roomCount||0).toLocaleString()}</div></div>
    <div class="card"><div class="stat-label">Version</div><div class="stat-value smaller" data-service-live="version">${esc(m.version||'—')}</div></div>
  </div>
  <div class="overview-grid">
    <div class="card info-card"><div class="section-head compact"><div class="section-title-with-logo">${serviceIcon('homeassistant','detail-os-logo')}<div><h2>Home Assistant</h2><p>Home automation instance</p></div></div>${serviceOpenLink(service,'Open Home Assistant')}</div><div class="info-grid">
      ${infoItem('Instance name',m.locationName||service.name)}${infoItem('Version',m.version||'—')}${infoItem('API endpoint',serviceWebUrl(service),true)}${infoItem('Time zone',m.timeZone||'—')}${infoItem('Components',m.componentsCount??'—')}${infoItem('System state',m.state||'—')}${infoItem('CPU sensor',m.cpu==null?'Not exposed':fmtPct(m.cpu))}${infoItem('Memory sensor',m.memoryPercent==null?'Not exposed':fmtPct(m.memoryPercent))}
    </div></div>
    <div class="card"><div class="section-head compact"><div><h2>Entity summary</h2><p>Current Home Assistant state registry</p></div></div><div class="traffic-values"><div><span>Automations</span><b data-service-live="automations">${Number(m.automationCount||0).toLocaleString()}</b></div><div><span>Lights</span><b data-service-live="lights">${Number(m.lightCount||0).toLocaleString()}</b></div><div><span>Switches</span><b data-service-live="switches">${Number(m.switchCount||0).toLocaleString()}</b></div><div><span>Sensors</span><b data-service-live="sensors">${Number(m.sensorCount||0).toLocaleString()}</b></div></div></div>
  </div>
  ${homeAssistantRoomsSection(m.rooms || [])}
  <div class="service-actions card"><div><h3>Home Assistant controls</h3><p>Use the Control tab for entities and Automations for routines. Restart calls Home Assistant's authenticated service API.</p></div><div class="service-action-buttons">${serviceOpenLink(service,'Open page')}<button type="button" class="ghost danger" id="homeassistant-restart">Restart Home Assistant</button></div><span id="service-action-result" class="muted"></span></div>`;
}

function linesToText(v){ return Array.isArray(v)?v.join('\n'):''; }
function textToLines(v){ return String(v||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean); }
function adguardDnsView(info={}) {
  return `<form id="adguard-dns-form" class="card dns-settings-card"><div class="section-head"><div><h2>DNS settings</h2><p>Configure upstream resolution, cache and DNS behavior.</p></div><button type="button" class="ghost" id="adguard-dns-reload">Reload</button></div>
    <div class="settings-form-grid dns-grid">
      <label class="span2">Upstream DNS servers<textarea name="upstream_dns" rows="5" placeholder="https://dns.cloudflare.com/dns-query">${esc(linesToText(info.upstream_dns))}</textarea></label>
      <label>Upstream mode<select name="upstream_mode"><option value="load_balance" ${info.upstream_mode==='load_balance'||!info.upstream_mode?'selected':''}>Load balance</option><option value="parallel" ${info.upstream_mode==='parallel'?'selected':''}>Parallel</option><option value="fastest_addr" ${info.upstream_mode==='fastest_addr'?'selected':''}>Fastest address</option></select></label>
      <label>Rate limit<input name="ratelimit" type="number" min="0" value="${esc(info.ratelimit??0)}" /></label>
      <label class="span2">Bootstrap DNS<textarea name="bootstrap_dns" rows="3">${esc(linesToText(info.bootstrap_dns))}</textarea></label>
      <label class="span2">Fallback DNS<textarea name="fallback_dns" rows="3">${esc(linesToText(info.fallback_dns))}</textarea></label>
      <label>Blocking mode<select name="blocking_mode">${['default','refused','nxdomain','null_ip','custom_ip'].map(x=>`<option value="${x}" ${info.blocking_mode===x?'selected':''}>${x}</option>`).join('')}</select></label>
      <label>Cache size (bytes)<input name="cache_size" type="number" min="0" value="${esc(info.cache_size??0)}" /></label>
      <label>Minimum cache TTL<input name="cache_ttl_min" type="number" min="0" value="${esc(info.cache_ttl_min??0)}" /></label>
      <label>Maximum cache TTL<input name="cache_ttl_max" type="number" min="0" value="${esc(info.cache_ttl_max??0)}" /></label>
      <label class="check"><input type="checkbox" name="cache_enabled" ${info.cache_enabled?'checked':''}/> Enable DNS cache</label>
      <label class="check"><input type="checkbox" name="cache_optimistic" ${info.cache_optimistic?'checked':''}/> Optimistic cache</label>
      <label class="check"><input type="checkbox" name="dnssec_enabled" ${info.dnssec_enabled?'checked':''}/> Enable DNSSEC</label>
      <label class="check"><input type="checkbox" name="resolve_clients" ${info.resolve_clients?'checked':''}/> Resolve client hostnames</label>
      <label class="check"><input type="checkbox" name="use_private_ptr_resolvers" ${info.use_private_ptr_resolvers?'checked':''}/> Use private PTR resolvers</label>
      <label class="check"><input type="checkbox" name="disable_ipv6" ${info.disable_ipv6?'checked':''}/> Disable IPv6 resolution</label>
      <label class="span2">Private reverse DNS servers<textarea name="local_ptr_upstreams" rows="3">${esc(linesToText(info.local_ptr_upstreams))}</textarea></label>
    </div><div class="settings-actions"><span id="adguard-dns-result" class="muted"></span><button type="submit" class="primary">Save DNS settings</button></div></form>`;
}

function adguardQueryLogView(rows=[], search='') {
  return `<div class="section-head"><div><h2>Query log</h2><p>Recent DNS queries reported by AdGuard Home</p></div><div class="log-tools"><input id="adguard-query-search" type="search" value="${esc(search)}" placeholder="Search domain or client…"/><button type="button" class="ghost" id="adguard-query-refresh">Refresh</button><button type="button" class="ghost danger" id="adguard-query-clear">Clear log</button></div></div>
    <div class="table-wrap"><table><thead><tr><th>Time</th><th>Client</th><th>Domain</th><th>Type</th><th>Response</th><th>Reason</th><th>Elapsed</th></tr></thead><tbody>${rows.length?rows.map(q=>{ const question=q.question||{}; const cname=q.client_info?.name; return `<tr><td>${esc(q.time?formatDateTime(q.time):'—')}</td><td><span class="mono">${esc(q.client||'—')}</span>${cname?`<small>${esc(cname)}</small>`:''}</td><td class="mono">${esc(question.name||'—')}</td><td>${esc(question.type||'—')}</td><td>${esc(q.status||'—')}</td><td>${esc(q.reason||'—')}</td><td>${q.elapsedMs==null?'—':`${Number(q.elapsedMs).toFixed(2)} ms`}</td></tr>`;}).join(''):'<tr><td colspan="7" class="table-empty">No DNS queries returned.</td></tr>'}</tbody></table></div>`;
}

function haEntityActions(entity) {
  const domain=entity.domain;
  if(['light','switch','fan','input_boolean','automation','siren','humidifier'].includes(domain)) return ['turn_on','turn_off','toggle'];
  if(domain==='script'||domain==='scene') return ['turn_on'];
  if(domain==='cover') return ['open_cover','close_cover','stop_cover'];
  if(domain==='lock') return ['lock','unlock'];
  if(domain==='button'||domain==='input_button') return ['press'];
  if(domain==='media_player') return ['turn_on','turn_off','media_play_pause'];
  return [];
}
function haActionLabel(action) { return ({turn_on:'On',turn_off:'Off',toggle:'Toggle',trigger:'Trigger',open_cover:'Open',close_cover:'Close',stop_cover:'Stop',lock:'Lock',unlock:'Unlock',press:'Press',media_play_pause:'Play / pause'})[action]||action; }
function homeAssistantControlView(entities=[]) {
  return `<div class="section-head device-section-head"><div><h2>Entity control</h2><p>Control Home Assistant entities from one simple list</p></div><span class="device-filter-count">${entities.length} entities</span></div>
    <div id="ha-entity-list" class="ha-entity-list">${entities.length?entities.map(e=>`<article class="card ha-entity-row"><div class="ha-entity-main"><div><b>${esc(e.name)}</b><span class="mono">${esc(e.entityId)}</span></div><span class="ha-state-pill ${['on','home','open','unlocked','playing'].includes(String(e.state).toLowerCase())?'active':''}">${esc(e.state||'—')}${e.unit?` ${esc(e.unit)}`:''}</span></div><div class="ha-entity-actions">${haEntityActions(e).map(a=>`<button type="button" class="ghost ha-control-action" data-entity="${esc(e.entityId)}" data-action="${esc(a)}">${esc(haActionLabel(a))}</button>`).join('')}</div></article>`).join(''):'<div class="empty">No controllable entities returned by Home Assistant.</div>'}</div><div id="ha-control-result" class="muted control-result"></div>`;
}

function homeAssistantAutomationsView(automations=[]) {
  return `<div class="section-head device-section-head"><div><h2>Automations</h2><p>Search, filter and manage Home Assistant automations</p></div></div>
    <div class="device-toolbar ha-inventory-toolbar">
      <label class="device-search">${heroIcon('search')}<input id="ha-automation-search" type="search" placeholder="Search automation…" /></label>
      <label class="device-type-filter">${heroIcon('funnel')}<select id="ha-automation-filter"><option value="all">All states</option><option value="on">Enabled</option><option value="off">Disabled</option></select></label>
      <span class="device-filter-count" id="ha-automation-count">${automations.length} of ${automations.length} automations</span>
    </div>
    <div id="ha-automation-list" class="ha-entity-list ha-automation-list">${automations.length?automations.map(a=>`<article class="card ha-entity-row ha-automation-row" data-state="${esc(String(a.state||'').toLowerCase())}" data-search="${esc(`${a.name} ${a.entityId} ${a.state}`.toLowerCase())}"><div class="ha-entity-main"><div><b>${esc(a.name)}</b><span class="mono">${esc(a.entityId)}</span><small class="ha-automation-meta">Last triggered: ${esc(a.lastTriggered?formatDateTime(a.lastTriggered):'Never')}${a.mode?` · ${esc(a.mode)}`:''}${a.current!=null?` · Running ${Number(a.current)}`:''}</small></div><span class="ha-state-pill ${String(a.state).toLowerCase()==='on'?'active':''}">${esc(a.state||'—')}</span></div><div class="ha-entity-actions"><button type="button" class="ghost ha-automation-action" data-entity="${esc(a.entityId)}" data-action="trigger">Trigger</button><button type="button" class="ghost ha-automation-action" data-entity="${esc(a.entityId)}" data-action="${String(a.state).toLowerCase()==='on'?'turn_off':'turn_on'}">${String(a.state).toLowerCase()==='on'?'Disable':'Enable'}</button></div></article>`).join(''):'<div class="empty">No automations returned by Home Assistant.</div>'}</div><div id="ha-automation-result" class="muted control-result"></div>`;
}

async function bindHomeAssistantAutomations(service, live) {
  const search=$('#ha-automation-search'), filter=$('#ha-automation-filter'), count=$('#ha-automation-count');
  const rows=$$('.ha-automation-row');
  const applyFilter=()=>{const q=(search?.value||'').trim().toLowerCase();const stateFilter=filter?.value||'all';let visible=0;rows.forEach(row=>{const hidden=(stateFilter!=='all'&&row.dataset.state!==stateFilter)||(q&&!row.dataset.search.includes(q));row.classList.toggle('hidden',hidden);if(!hidden)visible++;});if(count)count.textContent=`${visible} of ${rows.length} automations`;};
  search?.addEventListener('input',applyFilter); filter?.addEventListener('change',applyFilter);
  $$('.ha-automation-action').forEach(btn=>btn.addEventListener('click',async()=>{const result=$('#ha-automation-result');btn.disabled=true;if(result)result.textContent=`Sending ${haActionLabel(btn.dataset.action)}…`;try{await api(`/api/services/${service.id}/homeassistant/control`,{method:'POST',body:JSON.stringify({entityId:btn.dataset.entity,action:btn.dataset.action})});if(result)result.textContent='Command sent';setTimeout(()=>loadServiceTab(service,live,'automations'),450);}catch(err){if(result)result.textContent=err.message;btn.disabled=false;}}));
}

async function bindHomeAssistantControls(service, live) {
  $$('.ha-control-action').forEach(btn=>btn.addEventListener('click',async()=>{const result=$('#ha-control-result');btn.disabled=true;if(result)result.textContent=`Sending ${haActionLabel(btn.dataset.action)}…`;try{await api(`/api/services/${service.id}/homeassistant/control`,{method:'POST',body:JSON.stringify({entityId:btn.dataset.entity,action:btn.dataset.action})});if(result)result.textContent='Command sent';setTimeout(()=>loadServiceTab(service,live,'control'),350);}catch(err){if(result)result.textContent=err.message;btn.disabled=false;}}));
}


function proxmoxNodeCards(nodes = []) {
  const list = Array.isArray(nodes) ? nodes : [];
  return `<div class="proxmox-node-grid detailed">${list.length ? list.map(node => {
    const online = node.status === 'online';
    const cpuParts = [node.cpuModel, node.cpuSockets ? `${node.cpuSockets} socket${Number(node.cpuSockets)===1?'':'s'}` : '', node.cpuCores ? `${node.cpuCores} core${Number(node.cpuCores)===1?'':'s'}` : '', node.cpuThreads ? `${node.cpuThreads} thread${Number(node.cpuThreads)===1?'':'s'}` : '', node.cpuMhz ? `${Math.round(node.cpuMhz)} MHz` : ''].filter(Boolean).join(' • ');
    const pci = Array.isArray(node.pcie) ? node.pcie : [];
    const pciRows = pci.length ? `<div class="proxmox-pci-list">${pci.map(dev=>`<div class="proxmox-pci-row"><span class="mono">${esc(dev.id||'PCI')}</span><div><b>${esc([dev.vendor,dev.device].filter(Boolean).join(' ')||dev.class||'PCI device')}</b><small>${esc([dev.class,dev.iommuGroup!=null?`IOMMU ${dev.iommuGroup}`:''].filter(Boolean).join(' • '))}</small></div></div>`).join('')}</div>` : '<div class="empty compact-empty">PCI/PCIe inventory is unavailable for this node or API token.</div>';
    return `<article class="card proxmox-node-card detailed"><div class="device-top"><div><b>${esc(node.node || 'node')}</b><span class="mono">${online ? (node.pveVersion || 'Cluster node') : 'Unavailable'}</span></div><span class="device-status-dot ${online ? 'up' : 'down'}"></span></div>
      <div class="mini-stats"><div><b>${fmtPct(node.cpu)}</b><span>CPU</span></div><div><b>${fmtPct(serviceMemoryPercent({memoryUsed:node.memoryUsed,memoryTotal:node.memoryTotal}))}</b><span>Memory</span></div><div><b>${fmtUptime(node.uptimeSec)}</b><span>Uptime</span></div></div>
      <div class="proxmox-node-hardware info-grid">${infoItem('Kernel',node.kernel||'—')}${infoItem('CPU',cpuParts||`${node.maxCpu||'—'} logical CPUs`)}${infoItem('RAM',node.memoryTotal?`${fmtBytes(node.memoryUsed)} / ${fmtBytes(node.memoryTotal)}`:'—')}${infoItem('Swap',node.swap?.total?`${fmtBytes(node.swap.used)} / ${fmtBytes(node.swap.total)}`:'—')}${infoItem('Root filesystem',node.rootfs?.total?`${fmtBytes(node.rootfs.used)} / ${fmtBytes(node.rootfs.total)}`:'—')}${infoItem('Boot mode',node.bootMode||'—')}${infoItem('PCI / PCIe devices',pci.length)}</div>
      <details class="proxmox-hardware-details"><summary>Hardware devices <span>${pci.length} PCI / PCIe</span></summary>${pciRows}</details>
    </article>`;
  }).join('') : '<div class="empty">No Proxmox nodes returned.</div>'}</div>`;
}

function proxmoxOverview(service, live = {}) {
  const m = live || {}; const online = Number(m.status) === 1;
  return `<div class="cards service-summary-cards">
    <div class="card"><div class="stat-label">Status</div><div class="stat-value status-text ${online?'up':'down'}" data-service-live="status">${online?'Online':'Offline'}</div></div>
    <div class="card"><div class="stat-label">CPU</div><div class="stat-value" data-service-live="cpu">${fmtPct(m.cpu)}</div></div>
    <div class="card"><div class="stat-label">Memory</div><div class="stat-value" data-service-live="memory">${fmtPct(serviceMemoryPercent(m))}</div><small data-service-live="memory-note">${m.memoryUsed ? `${fmtBytes(m.memoryUsed)} / ${fmtBytes(m.memoryTotal)}` : '—'}</small></div>
    <div class="card"><div class="stat-label">Guests</div><div class="stat-value" data-service-live="guests">${Number(m.guestCount||0).toLocaleString()}</div><small><span data-service-live="running">${Number(m.runningCount||0).toLocaleString()}</span> running</small></div>
  </div>
  <div class="overview-grid">
    <div class="card info-card"><div class="section-head compact"><div class="section-title-with-logo">${serviceIcon('proxmox','detail-os-logo')}<div><h2>Proxmox VE</h2><p>Virtualization platform</p></div></div>${serviceOpenLink(service,'Open Proxmox')}</div><div class="info-grid">
      ${infoItem('Service name',service.name)}${infoItem('Version',m.version||'—')}${infoItem('Cluster',m.clusterName||'Standalone / unknown')}${infoItem('API endpoint',serviceWebUrl(service),true)}${infoItem('Nodes',`${Number(m.onlineNodeCount||0)} / ${Number(m.nodeCount||0)} online`)}${infoItem('Virtual machines',Number(m.vmCount||0).toLocaleString())}${infoItem('Containers',Number(m.lxcCount||0).toLocaleString())}${infoItem('Running guests',Number(m.runningCount||0).toLocaleString())}
    </div></div>
    <div class="card"><div class="section-head compact"><div><h2>Guest summary</h2><p>Cluster-wide QEMU and LXC inventory</p></div></div><div class="traffic-values"><div><span>QEMU VMs</span><b data-service-live="vms">${Number(m.vmCount||0).toLocaleString()}</b></div><div><span>LXC containers</span><b data-service-live="lxcs">${Number(m.lxcCount||0).toLocaleString()}</b></div><div><span>Running</span><b data-service-live="running-2">${Number(m.runningCount||0).toLocaleString()}</b></div><div><span>Nodes online</span><b data-service-live="nodes">${Number(m.onlineNodeCount||0)} / ${Number(m.nodeCount||0)}</b></div></div></div>
  </div>
  <div class="section-head proxmox-nodes-head"><div><h2>Nodes</h2><p>Live cluster node utilization</p></div></div>${proxmoxNodeCards(m.nodes || [])}
  <div class="service-actions card"><div><h3>Proxmox management</h3><p>Use the Guests tab to start, shut down, reboot, or force-stop QEMU virtual machines and LXC containers through the Proxmox API.</p></div><div class="service-action-buttons">${serviceOpenLink(service,'Open page')}</div></div>`;
}

function proxmoxGuestsView(guests = [], search = 'all') {
  const rows = Array.isArray(guests) ? guests : [];
  const types = ['all','qemu','lxc'];
  return `<div class="section-head proxmox-guests-head"><div><h2>Virtual machines & containers</h2><p>Search, filter and manage QEMU virtual machines and LXC containers</p></div><button type="button" class="ghost" id="proxmox-guests-refresh">Refresh</button></div>
    <div class="device-toolbar proxmox-guest-toolbar">
      <label class="device-search">${heroIcon('search')}<input id="proxmox-guest-search" type="search" autocomplete="off" placeholder="Search guest name, VMID or node…" /></label>
      <label class="device-type-filter">${heroIcon('funnel')}<select id="proxmox-guest-type" aria-label="Filter guests by type">${types.map(t=>`<option value="${t}" ${search===t?'selected':''}>${t==='all'?'All guest types':t==='qemu'?'Virtual machines':'LXC containers'}</option>`).join('')}</select></label>
      <span id="proxmox-guest-filter-count" class="device-filter-count"></span>
    </div>
    <div id="proxmox-guest-list" class="proxmox-guest-list guest-cards">${rows.length ? rows.map(g=>{
      const running=g.status==='running'; const mem=serviceMemoryPercent({memoryUsed:g.memoryUsed,memoryTotal:g.memoryTotal});
      const searchText=`${g.name} ${g.vmid} ${g.node} ${g.type} ${g.status}`.toLowerCase();
      return `<article class="card proxmox-guest-row" data-type="${esc(g.type)}" data-search="${esc(searchText)}"><div class="proxmox-guest-main"><div class="proxmox-guest-title"><span class="guest-type-pill ${g.type}">${g.type==='lxc'?'LXC':'VM'}</span><div><b>${esc(g.name)}</b><span class="mono">VMID ${g.vmid} • ${esc(g.node)}</span></div></div><span class="ha-state-pill ${running?'active':''}">${esc(g.status||'unknown')}</span></div>
        <div class="proxmox-guest-stats"><span><small>CPU</small><b>${fmtPct(g.cpu)}</b><em>${g.maxCpu?`${g.maxCpu} vCPU`:'—'}</em></span><span><small>Memory</small><b>${fmtPct(mem)}</b><em>${g.memoryTotal?`${fmtBytes(g.memoryUsed)} / ${fmtBytes(g.memoryTotal)}`:'—'}</em></span><span><small>Disk</small><b>${g.diskTotal?fmtPct((g.diskUsed/g.diskTotal)*100):'—'}</b><em>${g.diskTotal?`${fmtBytes(g.diskUsed)} / ${fmtBytes(g.diskTotal)}`:'—'}</em></span><span><small>Uptime</small><b>${fmtUptime(g.uptimeSec)}</b><em>${g.lock?`Locked: ${esc(g.lock)}`:'No lock'}</em></span></div>
        <div class="proxmox-guest-actions">${running?`<button type="button" class="ghost proxmox-guest-action" data-action="shutdown" data-type="${g.type}" data-node="${esc(g.node)}" data-vmid="${g.vmid}">Shutdown</button><button type="button" class="ghost proxmox-guest-action" data-action="reboot" data-type="${g.type}" data-node="${esc(g.node)}" data-vmid="${g.vmid}">Reboot</button><button type="button" class="ghost danger proxmox-guest-action" data-action="stop" data-type="${g.type}" data-node="${esc(g.node)}" data-vmid="${g.vmid}">Force stop</button>`:`<button type="button" class="primary proxmox-guest-action" data-action="start" data-type="${g.type}" data-node="${esc(g.node)}" data-vmid="${g.vmid}">Start</button>`}</div></article>`;
    }).join('') : '<div class="empty">No QEMU virtual machines or LXC containers were returned.</div>'}</div><div id="proxmox-guest-result" class="muted control-result"></div>`;
}

async function bindProxmoxGuests(service, live) {
  const filter=()=>{const q=($('#proxmox-guest-search')?.value||'').trim().toLowerCase();const type=$('#proxmox-guest-type')?.value||'all';let visible=0;$$('.proxmox-guest-row').forEach(row=>{const hidden=(type!=='all'&&row.dataset.type!==type)||(q&&!row.dataset.search.includes(q));row.classList.toggle('hidden',hidden);if(!hidden)visible+=1;});const count=$('#proxmox-guest-filter-count');if(count)count.textContent=`${visible} of ${$$('.proxmox-guest-row').length} guests`;};
  $('#proxmox-guest-search')?.addEventListener('input',filter); $('#proxmox-guest-type')?.addEventListener('change',filter); filter();
  $('#proxmox-guests-refresh')?.addEventListener('click',()=>loadServiceTab(service,live,'guests'));
  $$('.proxmox-guest-action').forEach(btn=>btn.addEventListener('click',async()=>{
    const action=btn.dataset.action; if(action==='stop'&&!confirm(`Force stop guest ${btn.dataset.vmid}? Unsaved data may be lost.`))return;
    const result=$('#proxmox-guest-result'); btn.disabled=true; if(result)result.textContent=`Sending ${action}…`;
    try{await api(`/api/services/${service.id}/proxmox/guests/control`,{method:'POST',body:JSON.stringify({type:btn.dataset.type,node:btn.dataset.node,vmid:Number(btn.dataset.vmid),action})});if(result)result.textContent='Command accepted by Proxmox';setTimeout(()=>loadServiceTab(service,live,'guests'),800);}catch(err){if(result)result.textContent=err.message;btn.disabled=false;}
  }));
}

function synologyHealthText(value) {
  if (value == null || value === '' || String(value).toLowerCase() === 'unknown') return '—';
  if (typeof value === 'boolean') return value ? 'Healthy' : 'Attention';
  return String(value);
}
function synologyOverview(service, live = {}) {
  const m=live||{}; const online=Number(m.status)===1; const mem=serviceMemoryPercent(m) ?? m.memoryPercent;
  return `<div class="cards service-summary-cards">
    <div class="card"><div class="stat-label">Status</div><div class="stat-value status-text ${online?'up':'down'}" data-service-live="status">${online?'Online':'Offline'}</div></div>
    <div class="card"><div class="stat-label">CPU</div><div class="stat-value" data-service-live="cpu">${fmtPct(m.cpu)}</div></div>
    <div class="card"><div class="stat-label">Memory</div><div class="stat-value" data-service-live="memory">${fmtPct(mem)}</div><small data-service-live="memory-note">${m.memoryUsed&&m.memoryTotal?`${fmtBytes(m.memoryUsed)} / ${fmtBytes(m.memoryTotal)}`:'—'}</small></div>
    <div class="card"><div class="stat-label">Storage</div><div class="stat-value" data-service-live="storage">${Number(m.volumeCount||0)} volumes</div><small><span data-service-live="disks">${Number(m.diskCount||0)}</span> disks</small></div>
  </div>
  <div class="overview-grid synology-overview-grid">
    <div class="card info-card"><div class="section-head compact"><div class="section-title-with-logo">${serviceIcon('synology','detail-os-logo')}<div><h2>Synology DSM</h2><p>NAS and storage platform</p></div></div>${serviceOpenLink(service,'Open DSM')}</div><div class="info-grid">
      ${infoItem('Service name',service.name)}${infoItem('Model',m.model||'—')}${infoItem('Serial number',m.serial||'—')}${infoItem('DSM version',m.version||'—')}${infoItem('Health',synologyHealthText(m.health))}${infoItem('Uptime',fmtUptime(m.uptimeSec))}${infoItem('Temperature',m.temperature==null?'—':`${Number(m.temperature).toFixed(0)} °C`)}${infoItem('DSM endpoint',serviceWebUrl(service),true)}
    </div></div>
    <div class="card"><div class="section-head compact"><div><h2>Inventory</h2><p>Storage and installed DSM packages</p></div></div><div class="traffic-values"><div><span>Volumes</span><b data-service-live="volumes">${Number(m.volumeCount||0).toLocaleString()}</b></div><div><span>Disks</span><b data-service-live="disks-2">${Number(m.diskCount||0).toLocaleString()}</b></div><div><span>Packages</span><b data-service-live="packages">${Number(m.packageCount||0).toLocaleString()}</b></div><div><span>Health</span><b data-service-live="health">${esc(synologyHealthText(m.health))}</b></div></div></div>
  </div>
  <div class="service-actions card"><div><h3>DSM management</h3><p>Open DSM normally, or send a system reboot/shutdown request using the configured DSM account.</p></div><div class="service-action-buttons">${serviceOpenLink(service,'Open DSM')}<button type="button" class="ghost" id="synology-reboot">Reboot</button><button type="button" class="ghost danger" id="synology-shutdown">Shutdown</button></div><div id="service-action-result" class="muted control-result"></div></div>`;
}
function synologyStorageView(data = {}) {
  const volumes=Array.isArray(data.volumes)?data.volumes:[], disks=Array.isArray(data.disks)?data.disks:[];
  return `<div class="section-head"><div><h2>Storage</h2><p>Volumes and physical disks reported by DSM</p></div><button type="button" class="ghost" id="synology-storage-refresh">Refresh</button></div>
    <div class="synology-storage-grid">
      <section class="card"><div class="section-head compact"><div><h3>Volumes</h3><p>${volumes.length} detected</p></div></div><div class="synology-item-list">${volumes.length?volumes.map(v=>`<article class="synology-item"><div><b>${esc(v.name||v.id||'Volume')}</b><small>${esc([v.fsType,v.status].filter(Boolean).join(' • ')||'DSM volume')}</small></div><div class="synology-item-stats"><span><small>Used</small><b>${v.used!=null?fmtBytes(v.used):'—'}</b></span><span><small>Total</small><b>${v.size!=null?fmtBytes(v.size):'—'}</b></span><span><small>Free</small><b>${v.free!=null?fmtBytes(v.free):'—'}</b></span></div></article>`).join(''):'<div class="empty">No volume inventory returned.</div>'}</div></section>
      <section class="card"><div class="section-head compact"><div><h3>Physical disks</h3><p>${disks.length} detected</p></div></div><div class="synology-item-list">${disks.length?disks.map(d=>`<article class="synology-item"><div><b>${esc(d.name||d.id||'Disk')}</b><small>${esc([d.vendor,d.model].filter(Boolean).join(' ')||'Physical disk')}</small></div><div class="synology-item-stats"><span><small>Health</small><b>${esc(d.status||'—')}</b></span><span><small>Temp</small><b>${d.temperature==null?'—':`${Number(d.temperature).toFixed(0)} °C`}</b></span><span><small>Size</small><b>${d.size!=null?fmtBytes(d.size):'—'}</b></span></div>${d.serial?`<span class="mono synology-serial">${esc(d.serial)}</span>`:''}</article>`).join(''):'<div class="empty">No disk inventory returned.</div>'}</div></section>
    </div>${data.errors&&Object.keys(data.errors).length?`<div class="notice">Some DSM storage endpoints were unavailable: ${esc(Object.values(data.errors).join(' · '))}</div>`:''}`;
}
function synologyPackagesView(data = {}) {
  const packages=Array.isArray(data.packages)?data.packages:[];
  return `<div class="section-head"><div><h2>DSM packages</h2><p>Installed package inventory</p></div></div>
    <div class="device-toolbar synology-package-toolbar"><label class="device-search">${heroIcon('search')}<input id="synology-package-search" type="search" placeholder="Search package name…" /></label><span id="synology-package-count" class="device-filter-count"></span></div>
    <div class="synology-package-list">${packages.length?packages.map(x=>`<article class="card synology-package-row" data-search="${esc(`${x.name} ${x.id} ${x.version} ${x.status}`.toLowerCase())}"><div><b>${esc(x.name||x.id||'Package')}</b><span class="mono">${esc(x.id||'')}</span></div><div><small>Version</small><b>${esc(x.version||'—')}</b></div><div><small>Status</small><b>${esc(x.status||'—')}</b></div></article>`).join(''):'<div class="empty">No DSM packages returned.</div>'}</div>${data.error?`<div class="notice error-notice">${esc(data.error)}</div>`:''}`;
}
function bindSynologyPackages() {
  const search=$('#synology-package-search'); const filter=()=>{const q=(search?.value||'').trim().toLowerCase();let shown=0;$$('.synology-package-row').forEach(r=>{const hide=q&&!r.dataset.search.includes(q);r.classList.toggle('hidden',hide);if(!hide)shown++;});const c=$('#synology-package-count');if(c)c.textContent=`${shown} packages`;};search?.addEventListener('input',filter);filter();
}
function bindSynologyOverview(service) {
  const run=async(action)=>{if(!confirm(`${action === 'shutdown' ? 'Shut down' : 'Reboot'} ${service.name}?`))return;const r=$('#service-action-result');if(r)r.textContent=`Sending ${action} request…`;try{await api(`/api/services/${service.id}/synology/control`,{method:'POST',body:JSON.stringify({action})});if(r)r.textContent=`${action === 'shutdown' ? 'Shutdown' : 'Reboot'} request sent`; }catch(err){if(r)r.textContent=err.message;}};
  $('#synology-reboot')?.addEventListener('click',()=>run('reboot')); $('#synology-shutdown')?.addEventListener('click',()=>run('shutdown'));
}


function casaOsOverview(service, live = {}) {
  const m = live || {}; const online = Number(m.status) === 1;
  return `<div class="cards service-summary-cards">
    <div class="card"><div class="stat-label">Status</div><div class="stat-value status-text ${online?'up':'down'}" data-service-live="status">${online?'Online':'Offline'}</div></div>
    <div class="card"><div class="stat-label">Installed apps</div><div class="stat-value" data-service-live="casa-apps">${Number(m.appCount||0).toLocaleString()}</div></div>
    <div class="card"><div class="stat-label">Running</div><div class="stat-value" data-service-live="casa-running">${Number(m.runningAppCount||0).toLocaleString()}</div></div>
    <div class="card"><div class="stat-label">Updates</div><div class="stat-value" data-service-live="casa-updates">${Number(m.updateCount||0).toLocaleString()}</div></div>
  </div>
  <div class="overview-grid">
    <div class="card info-card"><div class="section-head compact"><div class="section-title-with-logo">${serviceIcon('casaos','detail-os-logo')}<div><h2>CasaOS</h2><p>Home server application platform</p></div></div>${serviceOpenLink(service,'Open CasaOS')}</div><div class="info-grid">
      ${infoItem('Service name',service.name)}${infoItem('CasaOS URL',serviceWebUrl(service),true)}${infoItem('Architecture',m.architecture||'—')}${infoItem('Installed apps',Number(m.appCount||0).toLocaleString())}${infoItem('Running apps',Number(m.runningAppCount||0).toLocaleString())}${infoItem('Updates available',Number(m.updateCount||0).toLocaleString())}
    </div></div>
    <div class="card"><div class="section-head compact"><div><h2>Application health</h2><p>Installed compose applications reported by CasaOS</p></div></div><div class="traffic-values"><div><span>Installed</span><b>${Number(m.appCount||0).toLocaleString()}</b></div><div><span>Running</span><b>${Number(m.runningAppCount||0).toLocaleString()}</b></div><div><span>Stopped / other</span><b>${Math.max(0,Number(m.appCount||0)-Number(m.runningAppCount||0)).toLocaleString()}</b></div><div><span>Updates</span><b>${Number(m.updateCount||0).toLocaleString()}</b></div></div></div>
  </div>
  <div class="service-actions card"><div><h3>CasaOS management</h3><p>Use the Apps tab to start, stop or restart installed compose applications through CasaOS AppManagement.</p></div><div class="service-action-buttons">${serviceOpenLink(service,'Open CasaOS')}</div></div>`;
}

function casaOsAppsView(apps = []) {
  const rows = Array.isArray(apps) ? apps : [];
  return `<div class="section-head"><div><h2>Installed apps</h2><p>Compose applications managed by CasaOS</p></div><button type="button" class="ghost" id="casa-apps-refresh">Refresh</button></div>
    <div class="casa-app-list">${rows.length ? rows.map(app => {
      const status=String(app.status||'unknown').toLowerCase(); const running=status==='running';
      return `<article class="card casa-app-row"><div class="casa-app-main"><div class="casa-app-icon">${serviceIcon('casaos')}</div><div><b>${esc(app.name||app.id)}</b><span class="mono">${esc(app.id)}</span>${app.description?`<small>${esc(app.description)}</small>`:''}</div></div><div class="casa-app-meta"><span class="ha-state-pill ${running?'active':''}">${esc(status)}</span>${app.updateAvailable?'<span class="role-pill client">Update available</span>':''}</div><div class="casa-app-actions">${running?`<button type="button" class="ghost casa-app-action" data-id="${esc(app.id)}" data-action="restart">Restart</button><button type="button" class="ghost danger casa-app-action" data-id="${esc(app.id)}" data-action="stop">Stop</button>`:`<button type="button" class="primary casa-app-action" data-id="${esc(app.id)}" data-action="start">Start</button>`}</div></article>`;
    }).join('') : '<div class="empty">No installed CasaOS compose apps were returned.</div>'}</div><div id="casa-app-result" class="muted control-result"></div>`;
}
function bindCasaOsApps(service, live) {
  $('#casa-apps-refresh')?.addEventListener('click',()=>loadServiceTab(service,live,'apps'));
  $$('.casa-app-action').forEach(btn=>btn.addEventListener('click',async()=>{const result=$('#casa-app-result');btn.disabled=true;if(result)result.textContent=`Sending ${btn.dataset.action}…`;try{await api(`/api/services/${service.id}/casaos/apps/${encodeURIComponent(btn.dataset.id)}/state`,{method:'POST',body:JSON.stringify({action:btn.dataset.action})});if(result)result.textContent='Command accepted';setTimeout(()=>loadServiceTab(service,live,'apps'),700);}catch(err){if(result)result.textContent=err.message;btn.disabled=false;}}));
}

function nginxProxyManagerOverview(service, live = {}) {
  const m = live || {}; const online = Number(m.status) === 1;
  return `<div class="cards service-summary-cards">
    <div class="card"><div class="stat-label">Status</div><div class="stat-value status-text ${online?'up':'down'}" data-service-live="status">${online?'Online':'Offline'}</div></div>
    <div class="card"><div class="stat-label">Proxy hosts</div><div class="stat-value" data-service-live="proxy-hosts">${Number(m.proxyHostCount||0).toLocaleString()}</div><small><span data-service-live="proxy-enabled">${Number(m.enabledProxyHostCount||0).toLocaleString()}</span> enabled</small></div>
    <div class="card"><div class="stat-label">Certificates</div><div class="stat-value" data-service-live="certificates">${Number(m.certificateCount||0).toLocaleString()}</div></div>
    <div class="card"><div class="stat-label">Expiring soon</div><div class="stat-value" data-service-live="cert-expiring">${Number(m.expiringCertificateCount||0).toLocaleString()}</div><small>within 30 days</small></div>
  </div>
  <div class="overview-grid">
    <div class="card info-card"><div class="section-head compact"><div class="section-title-with-logo">${serviceIcon('nginxproxymanager','detail-os-logo')}<div><h2>Nginx Proxy Manager</h2><p>Reverse proxy management</p></div></div>${serviceOpenLink(service,'Open Nginx Proxy Manager')}</div><div class="info-grid">
      ${infoItem('Service name',service.name)}${infoItem('Admin URL',serviceWebUrl(service),true)}${infoItem('API base',`${serviceWebUrl(service)}/api`,true)}${infoItem('Authentication','Bearer API token')}${infoItem('Proxy hosts',Number(m.proxyHostCount||0).toLocaleString())}${infoItem('Certificates',Number(m.certificateCount||0).toLocaleString())}
    </div></div>
    <div class="card"><div class="section-head compact"><div><h2>Proxy summary</h2><p>Current NPM API inventory</p></div></div><div class="traffic-values"><div><span>Enabled hosts</span><b>${Number(m.enabledProxyHostCount||0).toLocaleString()}</b></div><div><span>Disabled hosts</span><b>${Math.max(0,Number(m.proxyHostCount||0)-Number(m.enabledProxyHostCount||0)).toLocaleString()}</b></div><div><span>Certificates</span><b>${Number(m.certificateCount||0).toLocaleString()}</b></div><div><span>Expiring &lt;30d</span><b>${Number(m.expiringCertificateCount||0).toLocaleString()}</b></div></div></div>
  </div>
  <div class="service-actions card"><div><h3>Proxy management</h3><p>Use Proxy Hosts to enable or disable routes and Certificates to renew managed certificates through Nginx Proxy Manager's API.</p></div><div class="service-action-buttons">${serviceOpenLink(service,'Open page')}</div></div>`;
}

function nginxProxyHostsView(hosts = []) {
  const rows = Array.isArray(hosts) ? hosts : [];
  return `<div class="section-head device-section-head"><div><h2>Proxy hosts</h2><p>View and control routes configured in Nginx Proxy Manager</p></div><button type="button" class="ghost" id="npm-hosts-refresh">Refresh</button></div>
    <div class="device-toolbar npm-toolbar"><label class="device-search">${heroIcon('search')}<input id="npm-host-search" type="search" placeholder="Search domain or upstream…" /></label><label class="device-type-filter">${heroIcon('funnel')}<select id="npm-host-filter"><option value="all">All hosts</option><option value="enabled">Enabled</option><option value="disabled">Disabled</option></select></label><span id="npm-host-count" class="device-filter-count"></span></div>
    <div id="npm-host-list" class="ha-entity-list npm-host-list">${rows.length ? rows.map(h=>`<article class="card ha-entity-row npm-host-row" data-enabled="${h.enabled?'enabled':'disabled'}" data-search="${esc(`${(h.domains||[]).join(' ')} ${h.forwardHost} ${h.forwardPort}`.toLowerCase())}"><div class="ha-entity-main"><div><b>${esc((h.domains||[]).join(', ')||`Proxy host #${h.id}`)}</b><span class="mono">${esc(h.forwardScheme)}://${esc(h.forwardHost)}:${Number(h.forwardPort||0)}</span><small>${h.sslForced?'Force SSL · ':''}${h.certificateName?`Certificate: ${esc(h.certificateName)}`:'No certificate'}</small></div><span class="ha-state-pill ${h.enabled?'active':''}">${h.enabled?'Enabled':'Disabled'}</span></div><div class="ha-entity-actions"><button type="button" class="ghost npm-host-state" data-id="${h.id}" data-enabled="${h.enabled?'0':'1'}">${h.enabled?'Disable':'Enable'}</button></div></article>`).join('') : '<div class="empty">No proxy hosts returned by Nginx Proxy Manager.</div>'}</div><div id="npm-host-result" class="muted control-result"></div>`;
}

function bindNginxProxyHosts(service, live) {
  const filter=()=>{const q=($('#npm-host-search')?.value||'').trim().toLowerCase(), mode=$('#npm-host-filter')?.value||'all';let shown=0;$$('.npm-host-row').forEach(r=>{const hide=(q&&!r.dataset.search.includes(q))||(mode!=='all'&&r.dataset.enabled!==mode);r.classList.toggle('hidden',hide);if(!hide)shown++;});const c=$('#npm-host-count');if(c)c.textContent=`${shown} hosts`;};
  $('#npm-host-search')?.addEventListener('input',filter); $('#npm-host-filter')?.addEventListener('change',filter); filter();
  $('#npm-hosts-refresh')?.addEventListener('click',()=>loadServiceTab(service,live,'proxyhosts'));
  $$('.npm-host-state').forEach(btn=>btn.addEventListener('click',async()=>{const result=$('#npm-host-result');btn.disabled=true;if(result)result.textContent='Applying…';try{await api(`/api/services/${service.id}/nginxproxymanager/proxy-hosts/${btn.dataset.id}/state`,{method:'POST',body:JSON.stringify({enabled:btn.dataset.enabled==='1'})});if(result)result.textContent='Updated';setTimeout(()=>loadServiceTab(service,live,'proxyhosts'),300);}catch(err){if(result)result.textContent=err.message;btn.disabled=false;}}));
}

function nginxCertificatesView(certs = []) {
  const rows=Array.isArray(certs)?certs:[];
  return `<div class="section-head device-section-head"><div><h2>Certificates</h2><p>Certificates known to Nginx Proxy Manager</p></div><button type="button" class="ghost" id="npm-cert-refresh">Refresh</button></div><div class="ha-entity-list npm-cert-list">${rows.length?rows.map(c=>{const expiry=c.expiresOn?Date.parse(c.expiresOn):NaN;const soon=Number.isFinite(expiry)&&expiry>Date.now()&&expiry<Date.now()+30*24*60*60_000;return `<article class="card ha-entity-row"><div class="ha-entity-main"><div><b>${esc(c.name||(c.domains||[]).join(', ')||`Certificate #${c.id}`)}</b><span class="mono">${esc((c.domains||[]).join(', ')||'No domains')}</span><small>${esc(c.provider||'certificate')} · expires ${c.expiresOn?esc(formatDateTime(c.expiresOn)):'—'}</small></div><span class="ha-state-pill ${soon?'':'active'}">${soon?'Expiring':'Valid'}</span></div><div class="ha-entity-actions"><button type="button" class="ghost npm-cert-renew" data-id="${c.id}">Renew</button></div></article>`;}).join(''):'<div class="empty">No certificates returned by Nginx Proxy Manager.</div>'}</div><div id="npm-cert-result" class="muted control-result"></div>`;
}

function bindNginxCertificates(service, live) {
  $('#npm-cert-refresh')?.addEventListener('click',()=>loadServiceTab(service,live,'certificates'));
  $$('.npm-cert-renew').forEach(btn=>btn.addEventListener('click',async()=>{if(!confirm('Request certificate renewal in Nginx Proxy Manager?'))return;const result=$('#npm-cert-result');btn.disabled=true;if(result)result.textContent='Renewing…';try{await api(`/api/services/${service.id}/nginxproxymanager/certificates/${btn.dataset.id}/renew`,{method:'POST'});if(result)result.textContent='Renewal requested';setTimeout(()=>loadServiceTab(service,live,'certificates'),600);}catch(err){if(result)result.textContent=err.message;btn.disabled=false;}}));
}


async function loadServiceTab(service, live, name=state.serviceTab) {
  const body=$('#service-tab-body'); if(!body) return;
  state.serviceTab=name; $$('.service-tab').forEach(x=>x.classList.toggle('active',x.dataset.tab===name));
  body.classList.remove('tab-enter');
  if (service.serviceType === 'casaos') {
    if(name==='overview') body.innerHTML=casaOsOverview(service,live);
    else if(name==='apps') {
      body.innerHTML='<div class="card skeleton-panel tall"></div>';
      try { const apps=await api(`/api/services/${service.id}/casaos/apps`); if(state.serviceTab!=='apps')return; body.innerHTML=casaOsAppsView(apps); bindCasaOsApps(service,live); } catch(err){body.innerHTML=`<div class="notice error-notice">${esc(err.message)}</div>`;}
    }
    void body.offsetWidth; body.classList.add('tab-enter'); return;
  }
  if (service.serviceType === 'nginxproxymanager') {
    if(name==='overview') body.innerHTML=nginxProxyManagerOverview(service,live);
    else if(name==='proxyhosts') {
      body.innerHTML='<div class="card skeleton-panel tall"></div>';
      try { const hosts=await api(`/api/services/${service.id}/nginxproxymanager/proxy-hosts`); if(state.serviceTab!=='proxyhosts')return; body.innerHTML=nginxProxyHostsView(hosts); bindNginxProxyHosts(service,live); } catch(err){body.innerHTML=`<div class="notice error-notice">${esc(err.message)}</div>`;}
    } else if(name==='certificates') {
      body.innerHTML='<div class="card skeleton-panel tall"></div>';
      try { const certs=await api(`/api/services/${service.id}/nginxproxymanager/certificates`); if(state.serviceTab!=='certificates')return; body.innerHTML=nginxCertificatesView(certs); bindNginxCertificates(service,live); } catch(err){body.innerHTML=`<div class="notice error-notice">${esc(err.message)}</div>`;}
    }
    void body.offsetWidth; body.classList.add('tab-enter'); return;
  }
  if (service.serviceType === 'proxmox') {
    if(name==='overview') body.innerHTML=proxmoxOverview(service,live);
    else if(name==='guests') {
      body.innerHTML='<div class="card skeleton-panel tall"></div>';
      try { const guests=await api(`/api/services/${service.id}/proxmox/guests`); if(state.serviceTab!=='guests')return; body.innerHTML=proxmoxGuestsView(guests); await bindProxmoxGuests(service,live); } catch(err){body.innerHTML=`<div class="notice error-notice">${esc(err.message)}</div>`;}
    }
    void body.offsetWidth; body.classList.add('tab-enter'); return;
  }
  if (service.serviceType === 'synology') {
    if(name==='overview') { body.innerHTML=synologyOverview(service,live); bindSynologyOverview(service); }
    else if(name==='storage') {
      body.innerHTML='<div class="card skeleton-panel tall"></div>';
      try { const storage=await api(`/api/services/${service.id}/synology/storage`); if(state.serviceTab!=='storage')return; body.innerHTML=synologyStorageView(storage); $('#synology-storage-refresh')?.addEventListener('click',()=>loadServiceTab(service,live,'storage')); } catch(err){body.innerHTML=`<div class="notice error-notice">${esc(err.message)}</div>`;}
    } else if(name==='packages') {
      body.innerHTML='<div class="card skeleton-panel tall"></div>';
      try { const packages=await api(`/api/services/${service.id}/synology/packages`); if(state.serviceTab!=='packages')return; body.innerHTML=synologyPackagesView(packages); bindSynologyPackages(); } catch(err){body.innerHTML=`<div class="notice error-notice">${esc(err.message)}</div>`;}
    }
    void body.offsetWidth; body.classList.add('tab-enter'); return;
  }
  if (service.serviceType === 'homeassistant') {
    if(name==='overview') {
      body.innerHTML=homeAssistantOverview(service,live);
      $('#homeassistant-restart')?.addEventListener('click',async()=>{if(!confirm('Restart Home Assistant? Automations and entity control may be briefly unavailable.'))return;const r=$('#service-action-result');if(r)r.textContent='Restart requested…';try{await api(`/api/services/${service.id}/homeassistant/restart`,{method:'POST'});if(r)r.textContent='Restart command sent';}catch(err){if(r)r.textContent=err.message;}});
    } else if(name==='control') {
      body.innerHTML='<div class="card skeleton-panel tall"></div>';
      try { const entities=await api(`/api/services/${service.id}/homeassistant/entities`); if(state.serviceTab!=='control')return; body.innerHTML=homeAssistantControlView(entities); await bindHomeAssistantControls(service,live); } catch(err){body.innerHTML=`<div class="notice error-notice">${esc(err.message)}</div>`;}
    }
    else if(name==='automations') {
      body.innerHTML='<div class="card skeleton-panel tall"></div>';
      try { const automations=await api(`/api/services/${service.id}/homeassistant/automations`); if(state.serviceTab!=='automations')return; body.innerHTML=homeAssistantAutomationsView(automations); await bindHomeAssistantAutomations(service,live); } catch(err){body.innerHTML=`<div class="notice error-notice">${esc(err.message)}</div>`;}
    }
    void body.offsetWidth; body.classList.add('tab-enter'); return;
  }

  if(name==='overview') {
    body.innerHTML=adguardOverview(service,live);
    $('#adguard-protection')?.addEventListener('click',async e=>{ const result=$('#service-action-result'); e.currentTarget.disabled=true; if(result)result.textContent='Applying…'; try{ live=await api(`/api/services/${service.id}/protection`,{method:'POST',body:JSON.stringify({enabled:!live.protectionEnabled})}); state.serviceLive.set(service.id,live); await loadServiceTab(service,live,'overview'); await refreshServices(); }catch(err){if(result)result.textContent=err.message;e.currentTarget.disabled=false;} });
    $('#adguard-cache-clear')?.addEventListener('click',async()=>{ const r=$('#service-action-result'); if(r)r.textContent='Clearing…'; try{await api(`/api/services/${service.id}/cache/clear`,{method:'POST'});if(r)r.textContent='Cache cleared';}catch(err){if(r)r.textContent=err.message;} });
    $('#adguard-process')?.addEventListener('click',async()=>{const r=$('#service-action-result');const enable=Number(live.status)!==1;if(r)r.textContent=enable?'Starting service…':'Stopping service…';try{await api(`/api/services/${service.id}/process`,{method:'POST',body:JSON.stringify({enabled:enable})});live={...live,status:enable?1:0,running:enable};state.serviceLive.set(service.id,live);await loadServiceTab(service,live,'overview');await api('/api/refresh',{method:'POST',body:JSON.stringify({serviceId:service.id})}).catch(()=>{});await refreshServices();}catch(err){if(r)r.textContent=err.message;}});
  } else if(name==='dns') {
    body.innerHTML='<div class="card skeleton-panel tall"></div>';
    try { const info=await api(`/api/services/${service.id}/dns`); if(state.serviceTab!=='dns')return; body.innerHTML=adguardDnsView(info); const reload=()=>loadServiceTab(service,live,'dns'); $('#adguard-dns-reload')?.addEventListener('click',reload); $('#adguard-dns-form')?.addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.currentTarget);const payload={upstream_dns:textToLines(f.get('upstream_dns')),bootstrap_dns:textToLines(f.get('bootstrap_dns')),fallback_dns:textToLines(f.get('fallback_dns')),local_ptr_upstreams:textToLines(f.get('local_ptr_upstreams')),upstream_mode:f.get('upstream_mode'),ratelimit:Number(f.get('ratelimit')||0),blocking_mode:f.get('blocking_mode'),cache_size:Number(f.get('cache_size')||0),cache_ttl_min:Number(f.get('cache_ttl_min')||0),cache_ttl_max:Number(f.get('cache_ttl_max')||0),cache_enabled:f.has('cache_enabled'),cache_optimistic:f.has('cache_optimistic'),dnssec_enabled:f.has('dnssec_enabled'),resolve_clients:f.has('resolve_clients'),use_private_ptr_resolvers:f.has('use_private_ptr_resolvers'),disable_ipv6:f.has('disable_ipv6')};const r=$('#adguard-dns-result');r.textContent='Saving…';try{await api(`/api/services/${service.id}/dns`,{method:'POST',body:JSON.stringify(payload)});r.textContent='Saved';setTimeout(()=>{if(r)r.textContent='';},1500);}catch(err){r.textContent=err.message;}}); } catch(err){body.innerHTML=`<div class="notice error-notice">${esc(err.message)}</div>`;}
  } else if(name==='querylog') {
    const load=async(search='')=>{body.innerHTML='<div class="card skeleton-panel tall"></div>';try{const data=await api(`/api/services/${service.id}/querylog?limit=200${search?`&search=${encodeURIComponent(search)}`:''}`);if(state.serviceTab!=='querylog')return;body.innerHTML=adguardQueryLogView(data.data||[],search);$('#adguard-query-refresh')?.addEventListener('click',()=>load($('#adguard-query-search')?.value||''));$('#adguard-query-search')?.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();load(e.currentTarget.value.trim());}});$('#adguard-query-clear')?.addEventListener('click',async()=>{if(!confirm('Clear the AdGuard Home query log?'))return;await api(`/api/services/${service.id}/querylog`,{method:'DELETE'});load('');});}catch(err){body.innerHTML=`<div class="notice error-notice">${esc(err.message)}</div>`;}}; await load(''); return;
  }
  void body.offsetWidth; body.classList.add('tab-enter');
}

async function renderService(fetchLive=true, showSkeleton=true) {
  const service=state.services.find(x=>x.id===state.selectedService);
  if(!service){state.page='devices';return renderDevices();}
  const label=serviceLabel(service.serviceType);
  setTitle(service.name,`${label} • ${service.host}`); if(showSkeleton)setContent(serviceSkeleton(),true);
  let live=serviceMetricOf(service);
  if(fetchLive){try{live=await api(`/api/services/${service.id}/live`);state.serviceLive.set(service.id,live);}catch(err){live={...live,status:0,liveError:err.message};}}
  const tabs=service.serviceType==='homeassistant'
    ? `<button type="button" class="tab service-tab ${state.serviceTab==='overview'?'active':''}" data-tab="overview">Overview</button><button type="button" class="tab service-tab ${state.serviceTab==='control'?'active':''}" data-tab="control">Control</button><button type="button" class="tab service-tab ${state.serviceTab==='automations'?'active':''}" data-tab="automations">Automations</button>`
    : service.serviceType==='proxmox'
      ? `<button type="button" class="tab service-tab ${state.serviceTab==='overview'?'active':''}" data-tab="overview">Overview</button><button type="button" class="tab service-tab ${state.serviceTab==='guests'?'active':''}" data-tab="guests">Guests</button>`
      : service.serviceType==='synology'
        ? `<button type="button" class="tab service-tab ${state.serviceTab==='overview'?'active':''}" data-tab="overview">Overview</button><button type="button" class="tab service-tab ${state.serviceTab==='storage'?'active':''}" data-tab="storage">Storage</button><button type="button" class="tab service-tab ${state.serviceTab==='packages'?'active':''}" data-tab="packages">Packages</button>`
        : service.serviceType==='nginxproxymanager'
          ? `<button type="button" class="tab service-tab ${state.serviceTab==='overview'?'active':''}" data-tab="overview">Overview</button><button type="button" class="tab service-tab ${state.serviceTab==='proxyhosts'?'active':''}" data-tab="proxyhosts">Proxy Hosts</button><button type="button" class="tab service-tab ${state.serviceTab==='certificates'?'active':''}" data-tab="certificates">Certificates</button>`
          : service.serviceType==='casaos'
            ? `<button type="button" class="tab service-tab ${state.serviceTab==='overview'?'active':''}" data-tab="overview">Overview</button><button type="button" class="tab service-tab ${state.serviceTab==='apps'?'active':''}" data-tab="apps">Apps</button>`
            : `<button type="button" class="tab service-tab ${state.serviceTab==='overview'?'active':''}" data-tab="overview">Overview</button><button type="button" class="tab service-tab ${state.serviceTab==='dns'?'active':''}" data-tab="dns">DNS settings</button><button type="button" class="tab service-tab ${state.serviceTab==='querylog'?'active':''}" data-tab="querylog">Query log</button>`;
  if(service.serviceType==='homeassistant'&&!['overview','control','automations'].includes(state.serviceTab))state.serviceTab='overview';
  if(service.serviceType==='proxmox'&&!['overview','guests'].includes(state.serviceTab))state.serviceTab='overview';
  if(service.serviceType==='synology'&&!['overview','storage','packages'].includes(state.serviceTab))state.serviceTab='overview';
  if(service.serviceType==='nginxproxymanager'&&!['overview','proxyhosts','certificates'].includes(state.serviceTab))state.serviceTab='overview';
  if(service.serviceType==='casaos'&&!['overview','apps'].includes(state.serviceTab))state.serviceTab='overview';
  if(service.serviceType==='adguardhome'&&!['overview','dns','querylog'].includes(state.serviceTab))state.serviceTab='overview';
  setContent(`<div class="detail-head"><button type="button" class="back button-with-icon" id="back-service">${heroIcon('chevronLeft')}<span>Back</span></button><div class="detail-head-actions">${serviceOpenLink(service,'Open page')}<button type="button" class="ghost button-with-icon" id="edit-service">${heroIcon('pencil')}<span>Edit</span></button><button type="button" class="ghost danger button-with-icon" id="delete-service">${heroIcon('trash')}<span>Delete</span></button></div></div>${live.liveError?`<div class="notice error-notice">Live query failed: ${esc(live.liveError)}</div>`:''}
    <div class="service-detail-title">${serviceIcon(service.serviceType,'service-detail-logo')}<div><h2>${esc(service.name)}</h2><p>${esc(serviceWebUrl(service))}</p></div></div>
    <div class="tabs">${tabs}</div><div id="service-tab-body"></div>`,false);
  bindServiceDetailActions(service); $$('.service-tab').forEach(t=>t.onclick=()=>loadServiceTab(service,live,t.dataset.tab)); await loadServiceTab(service,live,state.serviceTab);
}

function patchText(selector, value) { const el=$(selector); if(el && el.textContent !== String(value)) { el.textContent=String(value); pulseUpdated(el); } }
function pulseUpdated(el) { /* Intentionally quiet: values change in place without flashing. */ }
function patchServiceOverview(service, metric={}) {
  if (service.serviceType === 'homeassistant') {
    const online=Number(metric.status)===1;
    const status=$('[data-service-live="status"]'); if(status){status.textContent=online?'Online':'Offline';status.classList.toggle('up',online);status.classList.toggle('down',!online);pulseUpdated(status);}
    patchText('[data-service-live="entities"]',Number(metric.entityCount||0).toLocaleString());
    patchText('[data-service-live="rooms"]',Number(metric.roomCount||0).toLocaleString());
    patchText('[data-service-live="version"]',metric.version||'—');
    patchText('[data-service-live="automations"]',Number(metric.automationCount||0).toLocaleString());
    patchText('[data-service-live="lights"]',Number(metric.lightCount||0).toLocaleString());
    patchText('[data-service-live="switches"]',Number(metric.switchCount||0).toLocaleString());
    patchText('[data-service-live="sensors"]',Number(metric.sensorCount||0).toLocaleString());
  } else if (service.serviceType === 'proxmox') {
    const online=Number(metric.status)===1;
    const status=$('[data-service-live="status"]'); if(status){status.textContent=online?'Online':'Offline';status.classList.toggle('up',online);status.classList.toggle('down',!online);pulseUpdated(status);}
    patchText('[data-service-live="cpu"]',fmtPct(metric.cpu)); patchText('[data-service-live="memory"]',fmtPct(serviceMemoryPercent(metric)));
    patchText('[data-service-live="memory-note"]',metric.memoryUsed?`${fmtBytes(metric.memoryUsed)} / ${fmtBytes(metric.memoryTotal)}`:'—');
    patchText('[data-service-live="guests"]',Number(metric.guestCount||0).toLocaleString()); patchText('[data-service-live="running"]',Number(metric.runningCount||0).toLocaleString());
    patchText('[data-service-live="vms"]',Number(metric.vmCount||0).toLocaleString()); patchText('[data-service-live="lxcs"]',Number(metric.lxcCount||0).toLocaleString());
    patchText('[data-service-live="running-2"]',Number(metric.runningCount||0).toLocaleString()); patchText('[data-service-live="nodes"]',`${Number(metric.onlineNodeCount||0)} / ${Number(metric.nodeCount||0)}`);
  } else if (service.serviceType === 'synology') {
    const online=Number(metric.status)===1; const status=$('[data-service-live="status"]'); if(status){status.textContent=online?'Online':'Offline';status.classList.toggle('up',online);status.classList.toggle('down',!online);pulseUpdated(status);}
    patchText('[data-service-live="cpu"]',fmtPct(metric.cpu)); patchText('[data-service-live="memory"]',fmtPct(serviceMemoryPercent(metric) ?? metric.memoryPercent)); patchText('[data-service-live="memory-note"]',metric.memoryUsed&&metric.memoryTotal?`${fmtBytes(metric.memoryUsed)} / ${fmtBytes(metric.memoryTotal)}`:'—');
    patchText('[data-service-live="storage"]',`${Number(metric.volumeCount||0)} volumes`); patchText('[data-service-live="disks"]',Number(metric.diskCount||0)); patchText('[data-service-live="volumes"]',Number(metric.volumeCount||0).toLocaleString()); patchText('[data-service-live="disks-2"]',Number(metric.diskCount||0).toLocaleString()); patchText('[data-service-live="packages"]',Number(metric.packageCount||0).toLocaleString()); patchText('[data-service-live="health"]',synologyHealthText(metric.health));
  } else if (service.serviceType === 'nginxproxymanager') {
    const online=Number(metric.status)===1; const status=$('[data-service-live="status"]'); if(status){status.textContent=online?'Online':'Offline';status.classList.toggle('up',online);status.classList.toggle('down',!online);}
    patchText('[data-service-live="proxy-hosts"]',Number(metric.proxyHostCount||0).toLocaleString());
    patchText('[data-service-live="proxy-enabled"]',Number(metric.enabledProxyHostCount||0).toLocaleString());
    patchText('[data-service-live="certificates"]',Number(metric.certificateCount||0).toLocaleString());
    patchText('[data-service-live="cert-expiring"]',Number(metric.expiringCertificateCount||0).toLocaleString());
  } else if (service.serviceType === 'casaos') {
    const online=Number(metric.status)===1; const status=$('[data-service-live="status"]'); if(status){status.textContent=online?'Online':'Offline';status.classList.toggle('up',online);status.classList.toggle('down',!online);}
    patchText('[data-service-live="casa-apps"]',Number(metric.appCount||0).toLocaleString());
    patchText('[data-service-live="casa-running"]',Number(metric.runningAppCount||0).toLocaleString());
    patchText('[data-service-live="casa-updates"]',Number(metric.updateCount||0).toLocaleString());
  } else {
    const stats=metric.stats||{}; const online=Number(metric.status)===1; const blocked=Number(stats.numBlockedFiltering||0),queries=Number(stats.numDnsQueries||0), pct=queries?blocked/queries*100:0;
    const status=$('[data-service-live="status"]'); if(status){status.textContent=online?'On':'Off';status.classList.toggle('up',online);status.classList.toggle('down',!online);pulseUpdated(status);}
    patchText('[data-service-live="cpu"]',fmtPct(metric.cpu)); patchText('[data-service-live="memory"]',fmtPct(serviceMemoryPercent(metric)));
    patchText('[data-service-live="memory-note"]',metric.memoryUsed?fmtBytes(metric.memoryUsed):'SSH metrics optional');
    patchText('[data-service-live="protection"]',metric.protectionEnabled?'Enabled':'Disabled'); patchText('[data-service-live="protection-short"]',metric.protectionEnabled?'On':'Off');
    patchText('[data-service-live="queries"]',queries.toLocaleString()); patchText('[data-service-live="blocked"]',`${blocked.toLocaleString()} · ${pct.toFixed(1)}%`); patchText('[data-service-live="response"]',stats.avgProcessingTime==null?'—':`${(Number(stats.avgProcessingTime)*1000).toFixed(2)} ms`);
  }
}

function updateOpenService(metric){ if(state.page!=='service')return; const service=state.services.find(x=>x.id===state.selectedService); if(service&&state.serviceTab==='overview') patchServiceOverview(service,metric); }

async function renderGenericDevice(showSkeleton = true) {
  const d = state.devices.find(x => x.id === state.selected);
  if (!d) { state.page = 'devices'; return renderDevices(); }
  setTitle(d.name, `${genericRoleLabel(d.deviceRole)} uptime monitor • ${d.host}`);
  if (showSkeleton) setContent(deviceSkeleton(), true);
  const h = await api(`/api/devices/${d.id}/uptime?hours=24`).catch(() => []);
  const ok = h.filter(x => Number(x.status) === 1).length;
  const pct = h.length ? (ok / h.length) * 100 : null;
  const u = state.uptime.get(d.id);
  const status = statusOf(d);
  setContent(`<div class="detail-head"><button type="button" class="back button-with-icon" id="back">${heroIcon('chevronLeft')}<span>Back</span></button><div class="detail-head-actions"><button type="button" class="ghost button-with-icon" id="edit-device">${heroIcon('pencil')}<span>Edit</span></button><button type="button" class="ghost danger button-with-icon" id="delete-device">${heroIcon('trash')}<span>Delete</span></button></div></div>
    <div class="cards">
      <div class="card"><div class="stat-label">Status</div><div class="stat-value status-text ${status}">${status === 'up' ? 'Online' : status === 'down' ? 'Down' : 'Unknown'}</div></div>
      <div class="card"><div class="stat-label">Latency</div><div class="stat-value">${fmtLatency(u?.latency_ms)}</div></div>
      <div class="card"><div class="stat-label">24h uptime</div><div class="stat-value">${pct == null ? '—' : `${pct.toFixed(2)}%`}</div></div>
      <div class="card"><div class="stat-label">Monitor</div><div class="stat-value smaller">ICMP</div></div>
    </div>
    <div class="overview-grid generic-overview">
      <div class="card info-card"><div class="section-head compact"><div class="section-title-with-logo">${deviceIcon(d, 'detail-os-logo')}<div><h2>Monitor information</h2><p>Uptime-only target</p></div></div></div><div class="info-grid">
        ${infoItem('Name', d.name)}${infoItem('IP / hostname', d.host, true)}${infoItem('Type', genericRoleLabel(d.deviceRole))}${infoItem('Check method', 'ICMP ping')}
      </div></div>
      <div class="card"><div class="section-head compact"><div><h2>Last check</h2><p>Latest ICMP result</p></div></div>${infoItem('Checked', u?.ts ? formatDateTime(u.ts) : 'Waiting for first check')}${infoItem('Latency', fmtLatency(u?.latency_ms))}</div>
    </div>
    <div class="card"><div class="section-head compact"><div><h2>24-hour availability</h2><p>${h.length} recorded checks</p></div></div>${uptimeBars(bucketUptime(h))}</div>`, false);
  bindDetailActions(d);
}

async function renderDevice(fetchLive = true, showSkeleton = true) {
  const d = state.devices.find(x => x.id === state.selected);
  if (!d) { state.page = 'devices'; return renderDevices(); }
  if (d.osType === 'generic') return renderGenericDevice(showSkeleton);
  if (d.osType === 'ruijie' && !['overview','interfaces','clients'].includes(state.deviceTab)) state.deviceTab = 'overview';
    setTitle(d.name, `${osLabel(d.osType)} • ${d.host}`);
  if (showSkeleton) setContent(deviceSkeleton(), true);

  let live = metricOf(d);
  let hist = [];
  if (fetchLive) {
    const [liveResult, histResult] = await Promise.all([
      api(`/api/devices/${d.id}/live`).catch(err => ({ ...live, liveError: err.message })),
      api(`/api/devices/${d.id}/metrics?hours=24`).catch(() => []),
    ]);
    live = liveResult;
    hist = histResult;
    if (live) state.live.set(d.id, live);
  } else {
    hist = await api(`/api/devices/${d.id}/metrics?hours=24`).catch(() => []);
  }

  setContent(`<div class="detail-head"><button type="button" class="back button-with-icon" id="back">${heroIcon('chevronLeft')}<span>Back</span></button><div class="detail-head-actions"><button type="button" class="ghost button-with-icon" id="edit-device">${heroIcon('pencil')}<span>Edit</span></button><button type="button" class="ghost danger button-with-icon" id="delete-device">${heroIcon('trash')}<span>Delete</span></button></div></div>
    ${live.liveError ? `<div class="notice error-notice">Live query failed: ${esc(live.liveError)}</div>` : ''}
    ${deviceSummaryCards(live, d)}
    <div class="tabs">
      <button type="button" class="tab ${state.deviceTab === 'overview' ? 'active' : ''}" data-tab="overview">Overview</button>
      <button type="button" class="tab ${state.deviceTab === 'interfaces' ? 'active' : ''}" data-tab="interfaces">Interfaces</button>
      ${d.osType !== 'ruijie' ? `<button type="button" class="tab ${state.deviceTab === 'wireless' ? 'active' : ''}" data-tab="wireless">Wireless</button>` : ''}
      <button type="button" class="tab ${state.deviceTab === 'clients' ? 'active' : ''}" data-tab="clients">Clients</button>
      ${d.osType === 'mikrotik' ? `<button type="button" class="tab ${state.deviceTab === 'queues' ? 'active' : ''}" data-tab="queues">Queues</button><button type="button" class="tab ${state.deviceTab === 'firewall' ? 'active' : ''}" data-tab="firewall">Firewall</button>` : ''}
      ${d.osType !== 'ruijie' ? `<button type="button" class="tab ${state.deviceTab === 'logs' ? 'active' : ''}" data-tab="logs">Logs</button><button type="button" class="tab ${state.deviceTab === 'terminal' ? 'active' : ''}" data-tab="terminal">SSH terminal</button>` : ''}
    </div>
    <div id="tab-body"></div>`, false);

  bindDetailActions(d);
  $$('.tab').forEach(t => t.onclick = () => switchTab(t.dataset.tab, d, live, hist, t));
  const activeButton = $(`.tab[data-tab="${state.deviceTab}"]`);
  switchTab(state.deviceTab, d, live, hist, activeButton, false);
}

function switchTab(name, d, live, hist, btn, updateButtons = true) {
  if (state.deviceTab === 'terminal' && name !== 'terminal') cleanupTerminal();
  cleanupAnalyticsTimer();
  state.deviceTab = name;
  if (updateButtons) $$('.tab').forEach(x => x.classList.toggle('active', x === btn));
  const body = $('#tab-body'); if (!body) return;
  body.classList.remove('tab-enter');
  if (name === 'overview') {
    body.innerHTML = deviceOverview(d, live, hist);
    bindRoleControl(d);
  }
  else if (name === 'interfaces') body.innerHTML = interfacesView(live);
  else if (name === 'wireless') return void loadWirelessTab(d, body);
  else if (name === 'clients') return void loadClientsTab(d, body, live);
  else if (name === 'queues' && d.osType === 'mikrotik') return void loadQueueTab(d, body);
  else if (name === 'firewall' && d.osType === 'mikrotik') return void loadFirewallTab(d, body);
  else if (name === 'logs') return void loadLogsTab(d, body);
  else if (name === 'terminal') return startTerminal(d, body);
  else body.innerHTML = '<div class="empty">This tab is not available for this device.</div>';
  void body.offsetWidth; body.classList.add('tab-enter');
}

function updateOpenDevice(metric) {
  const cpu = $('[data-live="cpu"]');
  const memory = $('[data-live="memory"]');
  const uptime = $('[data-live="uptime"]');
  const clients = $('[data-live="clients"]');
  if (cpu) cpu.textContent = fmtPct(metric.cpu);
  if (memory) memory.textContent = fmtPct(memoryPercent(metric));
  if (uptime) uptime.textContent = fmtUptime(metric.uptimeSec ?? metric.uptime_sec);
  if (clients) clients.textContent = clientCount(metric);

  // Never replace the terminal DOM from a background metric event.
  if (state.deviceTab === 'clients') {
    const body = $('#tab-body');
    const currentDevice = state.devices.find(x=>x.id===state.selected);
    if (body && currentDevice) {
      const template = document.createElement('template');
      template.innerHTML = clientsView(metric, currentDevice, state.routerData.internetBlocks || []);
      ['wifi','dhcp','neighbors','internet'].forEach(kind => {
        const current = body.querySelector(`[data-client-table="${kind}"] tbody`);
        const next = template.content.querySelector(`[data-client-table="${kind}"] tbody`);
        if (current && next && current.innerHTML !== next.innerHTML) { current.innerHTML = next.innerHTML; pulseUpdated(current.closest('.table-wrap')); }
      });
      bindInternetBlockControls(currentDevice, body, metric);
    }
  } else if (state.deviceTab === 'interfaces') {
    const body = $('#tab-body');
    if (body) { body.classList.add('soft-tab-updating'); body.innerHTML = interfacesView(metric); requestAnimationFrame(()=>body.classList.remove('soft-tab-updating')); }
  } else if (state.deviceTab === 'overview') {
    const traffic = $$('.traffic-values b');
    if (traffic[0]) traffic[0].textContent = fmtBytes(metric.rxBytes ?? metric.rx_bytes);
    if (traffic[1]) traffic[1].textContent = fmtBytes(metric.txBytes ?? metric.tx_bytes);
  }
}

function startTerminal(d, body) {
  cleanupTerminal();
  body.innerHTML = `<div class="terminal-shell"><div class="terminal-bar"><span>SSH • ${esc(d.name)} (${esc(d.host)})</span><span id="term-status">connecting…</span></div><div id="terminal" class="terminal"></div></div>`;
  const target = $('#terminal');
  if (!target) return;

  const terminal = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace',
    theme: {
      background: getComputedStyle(document.documentElement).getPropertyValue('--terminal-bg').trim() || '#1e1e2e',
      foreground: getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#cdd6f4',
      cursor: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#cba6f7',
      selectionBackground: getComputedStyle(document.documentElement).getPropertyValue('--selection').trim() || '#45475a',
    },
    scrollback: 5000,
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(target);
  fit.fit();

  const ts = io('/terminal');
  const status = () => $('#term-status');
  terminal.onData(data => ts.emit('data', data));
  ts.on('connect', () => ts.emit('open', { deviceId: d.id, cols: terminal.cols, rows: terminal.rows }));
  ts.on('opened', () => { if (status()) status().textContent = 'connected'; terminal.focus(); });
  ts.on('data', data => terminal.write(data));
  ts.on('terminal-error', err => {
    if (status()) status().textContent = 'error';
    terminal.writeln(`\r\n\x1b[31m${err}\x1b[0m`);
  });
  ts.on('closed', () => { if (status()) status().textContent = 'closed'; });

  const resizeHandler = () => {
    if (state.deviceTab !== 'terminal') return;
    try {
      fit.fit();
      ts.emit('resize', { cols: terminal.cols, rows: terminal.rows });
    } catch {}
  };
  window.addEventListener('resize', resizeHandler);
  state.terminal = { socket: ts, terminal, fit, resizeHandler };
}

async function refreshCurrentPage() {
  const btn = $('#refresh-page');
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  btn.classList.add('refreshing');
  beginSoftRefresh();
  try {
    if (state.page === 'settings') {
      await renderSettings(false);
      return;
    }
    await api('/api/refresh', {
      method: 'POST',
      body: JSON.stringify({ deviceId: state.page === 'device' ? state.selected : null, serviceId: state.page === 'service' ? state.selectedService : null }),
    });
    await Promise.all([refreshDevices(), refreshServices()]);
    if (state.page === 'device') {
      const d = state.devices.find(x => x.id === state.selected);
      if (d?.osType === 'generic') {
        const u=state.uptime.get(d.id); const status=$('.status-text'); if(status&&u){const up=Number(u.status)===1;status.textContent=up?'Online':'Down';status.classList.toggle('up',up);status.classList.toggle('down',!up);pulseUpdated(status);}
      } else {
        const live = await api(`/api/devices/${state.selected}/live`).catch(() => null);
        if (live) { state.live.set(state.selected, live); updateOpenDevice(live); }
        if (d && !['overview','terminal'].includes(state.deviceTab)) { const active=$(`.tab[data-tab="${state.deviceTab}"]`); switchTab(state.deviceTab, d, live || metricOf(d), [], active, false); }
      }
    } else if (state.page === 'service') {
      const service=state.services.find(x=>x.id===state.selectedService); const live=service?await api(`/api/services/${service.id}/live`).catch(()=>null):null;
      if(service&&live){state.serviceLive.set(service.id,live);if(state.serviceTab==='overview')patchServiceOverview(service,live);else await loadServiceTab(service,live,state.serviceTab);}
    } else if (state.page === 'uptime') await renderUptime(false);
    else if (state.page === 'dashboard') { patchOverviewSummary(); state.devices.forEach(d=>patchDashboardDevice(d.id)); state.services.forEach(x=>patchDashboardService(x.id)); loadPublicIp(true); }
    else if (state.page === 'devices') { state.devices.forEach(d=>patchDeviceListRow(d.id)); state.services.forEach(x=>patchServiceListRow(x.id)); }
    else if (state.page === 'topology') await renderTopology(false);
  } finally {
    btn.disabled = false;
    endSoftRefresh();
    setTimeout(() => btn.classList.remove('refreshing'), 250);
  }
}
$('#refresh-page').addEventListener('click', refreshCurrentPage);

function render(animate = true) {
  if (state.page === 'dashboard') renderDashboard(animate);
  else if (state.page === 'devices') renderDevices(animate);
  else if (state.page === 'topology') renderTopology(animate);
  else if (state.page === 'uptime') renderUptime(animate);
  else if (state.page === 'settings') renderSettings(animate);
  else if (state.page === 'device') renderDevice(true, animate);
  else if (state.page === 'service') renderService(true, animate);
}

const dialog = $('#device-dialog');
function setFormField(name, value) {
  const el = $('#device-form')?.elements?.namedItem(name);
  if (!el || value == null) return;
  if (el.type === 'checkbox') el.checked = Boolean(value);
  else el.value = String(value);
}
function setDialogMode(editing = false, kind = 'device') {
  const title = dialog.querySelector('.dialog-head h2');
  const subtitle = dialog.querySelector('.dialog-head p');
  const entry = $('#entry-kind'), os = $('#os-type'), service = $('#service-type');
  if (title) title.textContent = editing ? `Edit ${kind === 'service' ? 'service' : 'device'}` : 'Add to RouterDeck';
  if (subtitle) subtitle.textContent = editing ? 'Update connection settings. Leave credential fields blank to keep their current values.' : 'Add a network device or a managed network service.';
  if (entry) { entry.value = kind; entry.disabled = editing; }
  if (os) os.disabled = editing && kind === 'device';
  if (service) service.disabled = editing && kind === 'service';
}
function prepareAddDialog(kind = 'device') {
  const form = $('#device-form'); form.reset();
  state.editTarget = null;
  setDialogMode(false, kind);
  const entry=$('#entry-kind'); if(entry) entry.value=kind;
  $('#os-type').value='openwrt'; $('#service-type').value='adguardhome';
  if ($('#openwrt-role')) $('#openwrt-role').value='client';
  if ($('#generic-role')) $('#generic-role').value='router';
  setFormField('sshUsername','root'); setFormField('sshPort',22); setFormField('serviceSshUsername','root'); setFormField('serviceSshPort',22);
  const error=$('#device-form-error'); if(error)error.textContent='';
  syncFormFields();
}
function showDeviceDialog() {
  dialog.classList.remove('dialog-closing');
  if (!dialog.open) dialog.showModal();
  requestAnimationFrame(() => requestAnimationFrame(() => dialog.classList.add('dialog-open')));
}
function closeDeviceDialog({ clearEdit = true } = {}) {
  if (!dialog.open) { if (clearEdit) state.editTarget = null; return Promise.resolve(); }
  dialog.classList.remove('dialog-open');
  dialog.classList.add('dialog-closing');
  return new Promise(resolve => {
    window.setTimeout(() => {
      if (dialog.open) dialog.close();
      dialog.classList.remove('dialog-closing');
      if (clearEdit) state.editTarget = null;
      resolve();
    }, 190);
  });
}
function openDialog(kind = 'device') {
  prepareAddDialog(kind);
  showDeviceDialog();
}
function openEditDialog(kind, id) {
  const form=$('#device-form'); form.reset();
  const item = kind === 'service' ? state.services.find(x=>x.id===id) : state.devices.find(x=>x.id===id);
  if (!item) return;
  state.editTarget = { kind, id };
  setDialogMode(true, kind);
  setFormField('entryKind',kind); setFormField('name',item.name); setFormField('host',item.host);
  if (kind === 'device') {
    setFormField('osType',item.osType);
    setFormField('restScheme',item.restScheme || 'https'); setFormField('restPort',item.restPort || '');
    setFormField('monitorInterface',item.monitorInterface || ''); setFormField('insecureTls',item.insecureTls);
    if (item.osType === 'mikrotik') setFormField('deviceRole',item.deviceRole || 'client');
    if (item.osType === 'openwrt') setFormField('openwrtRole',item.deviceRole === 'access_point' ? 'access_point' : 'client');
    if (item.osType === 'generic') setFormField('genericRole', ['router','access_point','switch','ip_camera'].includes(item.deviceRole) ? item.deviceRole : 'router');
    ['sshPassword','apiPassword','ruijieAppSecret','ruijieApiToken','sshPort'].forEach(n=>{const el=form.elements.namedItem(n);if(el){el.value='';el.placeholder='Leave blank to keep current';}});
    ['sshUsername','apiUsername','ruijieAppId','ruijieSerialNumber'].forEach(n=>{const el=form.elements.namedItem(n);if(el){el.value='';el.placeholder='Leave blank to keep current';}});
  } else {
    setFormField('serviceType',item.serviceType); setFormField('serviceScheme',item.scheme || 'http'); setFormField('servicePort',item.port || '');
    setFormField('serviceInsecureTls',item.insecureTls); setFormField('serviceSshMetrics',item.sshMetrics);
    ['serviceApiUsername','serviceApiPassword','serviceSshUsername','serviceSshPassword','serviceSshPort','homeAssistantToken','proxmoxApiTokenId','proxmoxApiTokenSecret','proxmoxUsername','proxmoxPassword','synologyUsername','synologyPassword','synologyOtpCode','npmIdentity','npmPassword','npmToken','casaUsername','casaPassword','casaAccessToken'].forEach(n=>{const el=form.elements.namedItem(n);if(el){el.value='';el.placeholder='Leave blank to keep current';}});
  }
  const error=$('#device-form-error'); if(error)error.textContent='';
  syncFormFields(); showDeviceDialog();
}
$('#add-device').onclick = () => openDialog('device');
$('#close-dialog').onclick = () => closeDeviceDialog();
$('#cancel-dialog').onclick = () => closeDeviceDialog();
dialog.addEventListener('cancel', e => { e.preventDefault(); closeDeviceDialog(); });

function syncServiceFields() {
  const type=$('#service-type')?.value || 'adguardhome';
  const isHa=type==='homeassistant', isProxmox=type==='proxmox', isSynology=type==='synology', isNpm=type==='nginxproxymanager', isCasa=type==='casaos', isAdguard=type==='adguardhome';
  $('#adguard-service-fields')?.classList.toggle('hidden',!isAdguard);
  $('#homeassistant-service-fields')?.classList.toggle('hidden',!isHa);
  $('#proxmox-service-fields')?.classList.toggle('hidden',!isProxmox);
  $('#synology-service-fields')?.classList.toggle('hidden',!isSynology);
  $('#nginxproxymanager-service-fields')?.classList.toggle('hidden',!isNpm);
  $('#casaos-service-fields')?.classList.toggle('hidden',!isCasa);
  const sshChecked=$('#service-ssh-metrics')?.checked;
  $('#service-ssh-fields')?.classList.toggle('hidden',!isAdguard||!sshChecked);
  const port=$('#service-port'); const scheme=$('#service-scheme');
  if(port){
    const expected=isHa?'8123':isProxmox?'8006':isSynology?'5001':isNpm?'81':isCasa?'80':'80'; port.placeholder=expected;
    if(isHa && (!port.value || ['80','81','8006','5001'].includes(port.value))) port.value='8123';
    if(isProxmox && (!port.value || ['80','81','8123','5001'].includes(port.value))) port.value='8006';
    if(isSynology && (!port.value || ['80','81','8123','8006'].includes(port.value))) port.value='5001';
    if(isNpm && (!port.value || ['80','8123','8006','5001'].includes(port.value))) port.value='81';
    if(isCasa && (!port.value || ['81','8123','8006','5001'].includes(port.value))) port.value='80';
    if(isAdguard && ['81','8123','8006','5001'].includes(port.value)) port.value='';
  }
  if(!state.editTarget && scheme && (isProxmox || isSynology)) scheme.value='https';
  if(!state.editTarget && scheme && (isNpm || isCasa)) scheme.value='http';
  const brand=$('#service-brand');
  if(brand) brand.innerHTML=isHa
    ? `<img src="/img/home-assistant.svg" alt="Home Assistant"/><div><strong>Home Assistant</strong><span>Home automation overview, uptime and entity control</span></div>`
    : isProxmox
      ? `<img src="/img/proxmox.svg" alt="Proxmox VE"/><div><strong>Proxmox VE</strong><span>Cluster, node, VM and container management through the PVE API</span></div>`
      : isSynology
        ? `<img src="/img/synology.svg" alt="Synology DSM"/><div><strong>Synology DSM</strong><span>NAS health, storage inventory and DSM management through WebAPI</span></div>`
        : isNpm
          ? `<img src="/img/nginx-proxy-manager.svg" alt="Nginx Proxy Manager"/><div><strong>Nginx Proxy Manager</strong><span>Reverse proxy hosts, certificates and uptime through the NPM API</span></div>`
          : isCasa
            ? `<img src="/img/casaos.svg" alt="CasaOS"/><div><strong>CasaOS</strong><span>Home-server apps, uptime and lifecycle controls through AppManagement</span></div>`
            : `<img src="/img/adguard-home.svg" alt="AdGuard Home"/><div><strong>AdGuard Home</strong><span>DNS filtering, uptime and query management</span></div>`;
}

function syncDeviceBrand() {
  const os=$('#os-type')?.value || 'openwrt'; const brand=$('#device-brand'); if(!brand)return;
  const genericRole = $('#generic-role')?.value || 'router';
  const detail=os==='mikrotik'?'RouterOS REST managed router or gateway':os==='generic'?`ICMP uptime-only ${genericRoleLabel(genericRole).toLowerCase()}`:os==='ruijie'?'Ruijie/Reyee Cloud-managed switch via pyruijie':($('#openwrt-role')?.value==='access_point'?'SSH / ubus access point':'SSH / ubus client/router');
  const icon = os === 'generic' ? deviceIcon({ osType:'generic', deviceRole:genericRole }, 'form-os-logo') : osIcon(os,'form-os-logo');
  brand.innerHTML=`${icon}<div><strong>${esc(osLabel(os))}</strong><span>${esc(detail)}</span></div>`;
  refreshThemeAwareLogos();
}

function syncFormFields() {
  const kind=$('#entry-kind')?.value || 'device';
  const deviceMode=kind==='device';
  $('#device-entry-fields')?.classList.toggle('hidden',!deviceMode);
  $('#service-entry-fields')?.classList.toggle('hidden',deviceMode);
  const nameInput=$('#device-form')?.querySelector('[name=name]');
  if(nameInput){const st=$('#service-type')?.value;nameInput.placeholder=deviceMode?'Living Room AP':(st==='homeassistant'?'Home Assistant':st==='proxmox'?'Proxmox VE':st==='synology'?'Synology DSM':st==='nginxproxymanager'?'Nginx Proxy Manager':st==='casaos'?'CasaOS':'AdGuard Home');}
  if(!deviceMode){ syncServiceFields(); return; }
  const os = $('#os-type').value;
  syncDeviceBrand();
  const generic = os === 'generic';
  const hostOption = $('#mikrotik-role')?.querySelector('option[value="host"]');
  const existingHost = state.devices.find(d => d.osType === 'mikrotik' && d.deviceRole === 'host' && d.id !== state.editTarget?.id);
  if (hostOption) { hostOption.disabled = Boolean(existingHost); hostOption.textContent = existingHost ? `Host / gateway (${existingHost.name} already selected)` : 'Host / gateway'; }
  $('#ssh-fields').classList.toggle('hidden', generic || os === 'ruijie');
  $('#openwrt-role-fields')?.classList.toggle('hidden', os !== 'openwrt');
  $('#generic-role-fields')?.classList.toggle('hidden', os !== 'generic');
  $('#mikrotik-fields').classList.toggle('hidden', os !== 'mikrotik');
  $('#ruijie-fields')?.classList.toggle('hidden', os !== 'ruijie');
  if (os === 'ruijie') {
    const existingRuijie = state.devices.find(d => d.osType === 'ruijie');
    const reuseRow = $('#ruijie-reuse-row'), reuse = $('#ruijie-reuse-existing');
    if (reuseRow) reuseRow.classList.toggle('hidden', !existingRuijie);
    if (reuse && existingRuijie && !reuse.dataset.initialized) { reuse.checked = true; reuse.dataset.initialized = '1'; }
    if (reuse && !existingRuijie) reuse.checked = false;
    const usingExisting = Boolean(existingRuijie && reuse?.checked);
    $$('.ruijie-account-field input, .ruijie-account-field select').forEach(el => { el.disabled = usingExisting; });
    const region = $('[name=ruijieBaseUrl]'); if (region) region.disabled = usingExisting;
  }
  $('#connection-mode').innerHTML = os === 'mikrotik'
    ? '<option value="rest">RouterOS REST API</option>'
    : generic ? '<option value="icmp">ICMP ping</option>' : os === 'ruijie' ? '<option value="cloud">Ruijie Cloud / pyruijie</option>' : '<option value="ssh">SSH / ubus</option>';
}
$('#entry-kind')?.addEventListener('change',syncFormFields);
$('#service-type')?.addEventListener('change',()=>{syncServiceFields();syncFormFields();});
$('#service-ssh-metrics')?.addEventListener('change',syncServiceFields);
$('#service-scheme')?.addEventListener('change',e=>{ if($('#service-type')?.value==='synology'){const port=$('#service-port');if(port&&(!port.value||['5000','5001'].includes(port.value)))port.value=e.currentTarget.value==='http'?'5000':'5001';} });
$('#openwrt-role')?.addEventListener('change', syncDeviceBrand);
$('#generic-role')?.addEventListener('change', syncDeviceBrand);
$('#ruijie-reuse-existing')?.addEventListener('change', syncFormFields);
$('#os-type').onchange = () => {
  const os = $('#os-type').value;
  const sshUser = document.querySelector('[name=sshUsername]');
  if (sshUser && (sshUser.value === 'root' || sshUser.value === 'admin')) sshUser.value = os === 'mikrotik' ? 'admin' : 'root';
  syncFormFields();
};

$('#device-form').addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.currentTarget;
  const f = new FormData(form);
  const obj = Object.fromEntries(f.entries());
  const editing = state.editTarget;
  const entryKind = editing?.kind || obj.entryKind || 'device';
  const error=$('#device-form-error'); if(error)error.textContent='';
  try {
    if(entryKind==='service') {
      const existingService = editing?.kind==='service' ? state.services.find(x=>x.id===editing.id) : null;
      const serviceType=existingService?.serviceType || (['adguardhome','homeassistant','proxmox','synology','nginxproxymanager','casaos'].includes(obj.serviceType)?obj.serviceType:'adguardhome');
      const payload={
        name:obj.name,host:obj.host,serviceType,
        scheme:serviceType==='proxmox'?'https':(obj.serviceScheme==='https'?'https':'http'),
        port:obj.servicePort?Number(obj.servicePort):(serviceType==='homeassistant'?8123:serviceType==='proxmox'?8006:serviceType==='synology'?(obj.serviceScheme==='http'?5000:5001):serviceType==='nginxproxymanager'?81:serviceType==='casaos'?80:null),
        insecureTls:f.has('serviceInsecureTls'),
        sshMetrics:serviceType==='adguardhome'&&f.has('serviceSshMetrics'),
        credentials:serviceType==='homeassistant'
          ? {accessToken:obj.homeAssistantToken||''}
          : serviceType==='proxmox'
            ? {apiTokenId:obj.proxmoxApiTokenId||'',apiTokenSecret:obj.proxmoxApiTokenSecret||'',username:obj.proxmoxUsername||'',password:obj.proxmoxPassword||''}
            : serviceType==='synology'
              ? {synologyUsername:obj.synologyUsername||'',synologyPassword:obj.synologyPassword||'',synologyDsmVersion:Number(obj.synologyDsmVersion||7),synologyOtpCode:obj.synologyOtpCode||''}
              : serviceType==='nginxproxymanager'
                ? {npmIdentity:obj.npmIdentity||'',npmPassword:obj.npmPassword||'',npmToken:obj.npmToken||''}
                : serviceType==='casaos'
                  ? {casaUsername:obj.casaUsername||'',casaPassword:obj.casaPassword||'',casaAccessToken:obj.casaAccessToken||''}
                  : {apiUsername:obj.serviceApiUsername||'',apiPassword:obj.serviceApiPassword||'',sshUsername:obj.serviceSshUsername||(editing?'':'root'),sshPassword:obj.serviceSshPassword||'',sshPort:obj.serviceSshPort?Number(obj.serviceSshPort):(editing?'':22)},
      };
      if (editing?.kind === 'service') {
        payload.credentials = Object.fromEntries(Object.entries(payload.credentials || {}).filter(([,v]) => v !== '' && v != null));
        // The public service object intentionally does not expose stored secrets/configuration.
        // Avoid replacing a Synology DSM version merely because the edit form defaulted to DSM 7.
        if (serviceType === 'synology' && !obj.synologyUsername && !obj.synologyPassword && !obj.synologyOtpCode) delete payload.credentials.synologyDsmVersion;
      }
      if(!editing && serviceType==='homeassistant'&&!String(payload.credentials.accessToken).trim()) throw new Error('Home Assistant access token is required');
      if(!editing && serviceType==='proxmox'&&!((String(payload.credentials.apiTokenId).trim()&&String(payload.credentials.apiTokenSecret).trim())||(String(payload.credentials.username).trim()&&String(payload.credentials.password)))) throw new Error('Proxmox API token or username/password is required');
      if(!editing && serviceType==='synology'&&(!String(payload.credentials.synologyUsername).trim()||!String(payload.credentials.synologyPassword))) throw new Error('Synology DSM username and password are required');
      if(!editing && serviceType==='nginxproxymanager'&&!String(payload.credentials.npmToken).trim()&&(!String(payload.credentials.npmIdentity).trim()||!String(payload.credentials.npmPassword))) throw new Error('Nginx Proxy Manager login or API token is required');
      if(!editing && serviceType==='casaos'&&!String(payload.credentials.casaAccessToken).trim()&&(!String(payload.credentials.casaUsername).trim()||!String(payload.credentials.casaPassword))) throw new Error('CasaOS username/password or access token is required');
      const saved=editing?.kind==='service'
        ? await api(`/api/services/${editing.id}`,{method:'PATCH',body:JSON.stringify(payload)})
        : await api('/api/services',{method:'POST',body:JSON.stringify(payload)});
      await api('/api/refresh',{method:'POST',body:JSON.stringify({serviceId:saved.id})}).catch(()=>{});
      await refreshServices();
    } else {
      const existingDevice = editing?.kind==='device' ? state.devices.find(x=>x.id===editing.id) : null;
      const osType = existingDevice?.osType || obj.osType;
      const payload = {
        name: obj.name, host: obj.host, osType,
        connectionMode: osType === 'mikrotik' ? 'rest' : osType === 'generic' ? 'icmp' : osType === 'ruijie' ? 'cloud' : 'ssh',
        restScheme: obj.restScheme,
        restPort: obj.restPort ? Number(obj.restPort) : null,
        monitorInterface: ['generic','ruijie'].includes(osType) ? null : (obj.monitorInterface || null),
        insecureTls: f.has('insecureTls'),
        deviceRole: osType === 'mikrotik' ? (obj.deviceRole === 'host' ? 'host' : 'client') : osType === 'openwrt' ? (obj.openwrtRole === 'access_point' ? 'access_point' : 'client') : osType === 'generic' ? (['router','access_point','switch','ip_camera'].includes(obj.genericRole) ? obj.genericRole : 'router') : 'client',
        credentials: osType === 'generic' ? {} : osType === 'ruijie' ? {
          ruijieAppId: obj.ruijieAppId || '', ruijieAppSecret: obj.ruijieAppSecret || '', ruijieSerialNumber: obj.ruijieSerialNumber || '', ruijieBaseUrl: obj.ruijieBaseUrl || 'auto', ruijieApiToken: obj.ruijieApiToken || '', ruijieReuseExisting: f.has('ruijieReuseExisting'),
        } : {
          sshUsername: obj.sshUsername || '', sshPassword: obj.sshPassword || '', sshPort: obj.sshPort ? Number(obj.sshPort) : (editing ? '' : 22),
          apiUsername: obj.apiUsername, apiPassword: obj.apiPassword,
        },
      };
      if (!editing && osType === 'ruijie' && !String(obj.ruijieSerialNumber||'').trim()) throw new Error('Ruijie/Reyee device serial number is required');
      if (!editing && osType === 'ruijie' && !f.has('ruijieReuseExisting') && (!String(obj.ruijieAppId||'').trim() || !String(obj.ruijieAppSecret||''))) throw new Error('Ruijie Cloud App ID and App Secret are required');
      if (editing?.kind === 'device') payload.credentials = Object.fromEntries(Object.entries(payload.credentials || {}).filter(([,v]) => v !== '' && v != null && v !== false));
      if (editing?.kind === 'device') await api(`/api/devices/${editing.id}`, { method:'PATCH', body:JSON.stringify(payload) });
      else await api('/api/devices', { method: 'POST', body: JSON.stringify(payload) });
      await refreshDevices();
    }
    await closeDeviceDialog({ clearEdit: false }); form.reset(); state.editTarget=null; setDialogMode(false,'device');
    const rr=$('#ruijie-reuse-existing'); if(rr) delete rr.dataset.initialized;
    $('#entry-kind').value='device'; $('#os-type').value='openwrt'; $('#service-type').value='adguardhome'; if($('#openwrt-role')) $('#openwrt-role').value='client'; if($('#generic-role')) $('#generic-role').value='router';
    const sshUser=document.querySelector('[name=sshUsername]'); if(sshUser)sshUser.value='root';
    const serviceSshUser=document.querySelector('[name=serviceSshUsername]'); if(serviceSshUser)serviceSshUser.value='root';
    const serviceSshPort=document.querySelector('[name=serviceSshPort]'); if(serviceSshPort)serviceSshPort.value='22';
    syncFormFields(); render(true);
  } catch (err) { if(error)error.textContent=err.message; }
});

function publicStatusSkeleton() {
  return `<div class="public-status-shell"><header class="public-status-head"><div class="public-brand">${brandLogo('public-brand-logo')}<div><div class="skeleton sk-title"></div><div class="skeleton sk-line"></div></div></div></header><div class="public-summary skeleton-panel">${Array.from({ length: 3 }, () => '<div class="skeleton sk-line"></div>').join('')}</div><div class="public-device-list">${Array.from({ length: 4 }, () => '<div class="public-device-card skeleton-panel"><div class="skeleton sk-line"></div><div class="skeleton sk-line"></div></div>').join('')}</div></div>`;
}

async function renderPublicStatus() {
  const root = $('#public-status');
  if (!root) return;
  try {
    const data = await publicApi('/api/public/status');
    const { settings, devices, branding = {} } = data;
    applyAppSettings({ appName: branding.appName || 'RouterDeck', theme: branding.theme || 'system', clockFormat: branding.clockFormat || '24h', timeZone: branding.timeZone || 'auto' });
    document.documentElement.style.setProperty('--status-accent', settings.accent || '#6f8cff');
    document.title = `${settings.title} · ${branding.appName || 'RouterDeck'}`;
    const down = devices.filter(d => d.status === 0).length;
    const up = devices.filter(d => d.status === 1).length;
    const unknown = devices.filter(d => d.status == null).length;
    const overallClass = down ? 'down' : up ? 'up' : 'unknown';
    const overallText = down ? `${down} monitor${down === 1 ? '' : 's'} down` : up ? 'All systems operational' : 'Waiting for first check';
    root.innerHTML = `<div class="public-status-shell">
      <header class="public-status-head"><div class="public-brand">${brandLogo('public-brand-logo')}<div><h1>${esc(settings.title)}</h1><p>${esc(settings.subtitle || '')}</p></div></div><button type="button" id="public-refresh" class="refresh-btn"><span class="refresh-icon">↻</span> Refresh</button></header>
      <section class="public-summary ${overallClass}"><div><span class="status-dot ${overallClass}"></span><strong>${esc(overallText)}</strong></div><div class="public-summary-meta">${up} up • ${down} down${unknown ? ` • ${unknown} unknown` : ''}</div></section>
      <section class="public-device-list">${devices.length ? devices.map(d => {
        const status = d.status == null ? 'unknown' : d.status ? 'up' : 'down';
        return `<article class="public-device-card"><div class="public-device-top"><div><div class="uptime-name-line">${d.kind === 'service' ? serviceIcon(d.type, 'status-os-logo') : deviceIcon({ osType:d.type, deviceRole:d.deviceRole }, 'status-os-logo')}<span class="status-dot ${status}"></span><h2>${esc(d.name)}</h2></div>${d.host ? `<div class="device-host">${esc(d.host)}</div>` : ''}</div><div class="public-device-meta"><b>${d.uptime24h == null ? '—' : `${Number(d.uptime24h).toFixed(2)}%`}</b><span>24h uptime</span></div></div>${uptimeBars(d.history || [])}<div class="public-card-foot"><span>${status === 'up' ? 'Operational' : status === 'down' ? 'Down' : 'Unknown'}</span><span>${fmtLatency(d.latencyMs)}${d.checkedAt ? ` • checked ${new Date(d.checkedAt).toLocaleTimeString([], dateOptionsWithZone({hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:clockHour12()})).replace(/:/g,'.')}` : ''}</span></div></article>`;
      }).join('') : '<div class="empty">No monitors configured.</div>'}</section>
      <footer class="public-status-footer">Powered by ${esc(branding.appName || 'RouterDeck')} • Updated ${formatDateTime(data.generatedAt)}</footer>
    </div>`;
    $('#public-refresh')?.addEventListener('click', async e => {
      e.currentTarget.classList.add('refreshing');
      await renderPublicStatus();
    });
    clearTimeout(state.publicTimer);
    state.publicTimer = setTimeout(renderPublicStatus, Math.max(10, Number(settings.refreshSeconds || 30)) * 1000);
  } catch (err) {
    root.innerHTML = `<div class="public-status-shell"><div class="public-summary down"><strong>Unable to load status</strong><p>${esc(err.message)}</p><button type="button" id="public-retry" class="primary">Try again</button></div></div>`;
    $('#public-retry')?.addEventListener('click', renderPublicStatus);
  }
}

async function bootPublicStatus() {
  await loadPublicBranding();
  clearTimeout(state.publicTimer);
  socket.disconnect();
  $('#login').classList.add('hidden');
  $('#app').classList.add('hidden');
  const root = $('#public-status');
  root.classList.remove('hidden');
  root.innerHTML = publicStatusSkeleton();
  await renderPublicStatus();
}

if (location.pathname === '/status' || location.pathname === '/status/') bootPublicStatus();
else boot();
