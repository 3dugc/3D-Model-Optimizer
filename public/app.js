import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { USDZLoader } from 'three/addons/loaders/USDZLoader.js';

let selectedFile = null, currentTaskId = null, modelAnalysis = null;
let webToken = localStorage.getItem('web_token') || '';
let rechargePackagesCents = [800, 1800, 3800, 8800];
let jobPriceCents = 100;
let currentWallet = null;
let wechatOAuthConfigured = false;
let wechatOAuthMode = 'offiaccount';
let localTestAccountEnabled = false;
let authServiceConfigured = false;
let authServiceLoginUrl = '';
let authServiceWidgetConfigPath = '';
let authServiceRedirectUri = '';
let nativePaymentConfigured = false;
let rechargePollTimer = null;
let wechatLoginScriptPromise = null;
let wechatLoginPollTimer = null;
let wireframeMode = false, viewMode = 'split';
let leftScene, leftCamera, leftRenderer, leftControls, leftModel;
let rightScene, rightCamera, rightRenderer, rightControls, rightModel;

const DRACO_DECODER_PATH = 'https://www.gstatic.com/draco/versioned/decoders/1.5.6/';
const KTX2_TRANSCODER_PATH = 'https://unpkg.com/three@0.160.0/examples/jsm/libs/basis/';

const uploadArea = document.getElementById('uploadArea');
const fileInput = document.getElementById('fileInput');
const fileName = document.getElementById('fileName');
const optimizeBtn = document.getElementById('optimizeBtn');
const loading = document.getElementById('loading');
const analyzeLoading = document.getElementById('analyzeLoading');
const resultSection = document.getElementById('resultSection');
const errorMsg = document.getElementById('errorMsg');
const downloadBtn = document.getElementById('downloadBtn');
const downloadListSection = document.getElementById('downloadListSection');
const downloadList = document.getElementById('downloadList');
const downloadListEmpty = document.getElementById('downloadListEmpty');
const refreshDownloadsBtn = document.getElementById('refreshDownloadsBtn');
const modelInfoSection = document.getElementById('modelInfoSection');
const optionsSection = document.getElementById('optionsSection');

function renderBuildVersion() {
  const versionEl = document.getElementById('buildVersion');
  if (!versionEl) return;
  const buildInfo = window.__APP_BUILD_INFO__;
  if (buildInfo?.version && buildInfo.version !== 'dev') {
    versionEl.textContent = `版本 ${buildInfo.version}`;
    versionEl.title = `打包时间：${buildInfo.builtAtBeijing}`;
    return;
  }
  versionEl.textContent = '版本 dev';
  versionEl.title = '开发模式';
}

function getWebAuthHeaders() { return webToken ? { 'Authorization': `Bearer ${webToken}` } : {}; }
function formatMoney(cents) { return `¥${(Number(cents || 0) / 100).toFixed(2)}`; }
function base64Url(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes.buffer);
}
async function sha256Base64Url(value) {
  const data = new TextEncoder().encode(value);
  return base64Url(await crypto.subtle.digest('SHA-256', data));
}
function sameOriginPathFromUrl(value) {
  if (!value) return '/';
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin) return '/';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch (error) {
    return '/';
  }
}
function consumeWebTokenFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const hashParams = window.location.hash.startsWith('#')
    ? new URLSearchParams(window.location.hash.slice(1))
    : new URLSearchParams();
  const token = params.get('web_token') || hashParams.get('web_token');
  const loginError = params.get('login_error') || hashParams.get('login_error');
  if (token) {
    webToken = token;
    localStorage.setItem('web_token', webToken);
  }
  if (loginError) {
    showError(`微信登录失败：${loginError}`);
  }
  if (token || loginError || params.get('login') || hashParams.get('login')) {
    params.delete('web_token');
    params.delete('login');
    params.delete('login_error');
    hashParams.delete('web_token');
    hashParams.delete('login');
    hashParams.delete('login_error');
    const nextSearch = params.toString();
    const nextHash = hashParams.toString();
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${nextHash ? `#${nextHash}` : ''}`
    );
  }
}

async function consumeAuthServiceCallbackFromUrl(callbackHref) {
  const callbackUrl = callbackHref ? new URL(callbackHref, window.location.origin) : window.location;
  if (callbackUrl.pathname !== '/auth/callback') return false;
  const params = new URLSearchParams(callbackUrl.search);
  const code = params.get('code');
  const state = params.get('state');
  const error = params.get('error');
  const returnTo = params.get('return_to') || sessionStorage.getItem('auth_service_return_to') || '/';
  const expectedState = sessionStorage.getItem('auth_service_state');
  const codeVerifier = sessionStorage.getItem('auth_service_code_verifier');

  function clearAuthServiceSession() {
    sessionStorage.removeItem('auth_service_state');
    sessionStorage.removeItem('auth_service_code_verifier');
    sessionStorage.removeItem('auth_service_return_to');
  }

  try {
    if (error) throw new Error(`统一登录失败：${error}`);
    if (!code) throw new Error('统一登录回调缺少授权码。');
    if (!state || !expectedState || state !== expectedState) throw new Error('统一登录 state 校验失败。');
    if (!codeVerifier) throw new Error('统一登录 PKCE 校验信息已失效，请重新登录。');

    const res = await fetch('/api/v1/account/auth/service/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, codeVerifier }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || '统一登录换取本地登录态失败。');
    webToken = data.token;
    localStorage.setItem('web_token', webToken);
    clearAuthServiceSession();
    window.history.replaceState(null, '', sameOriginPathFromUrl(returnTo));
    displayAccount(data.user, data.wallet);
    return true;
  } catch (callbackError) {
    clearAuthServiceSession();
    window.history.replaceState(null, '', '/');
    showError(callbackError.message);
    return true;
  }
}

async function loadAccountProviders() {
  try {
    const res = await fetch('/api/v1/account/auth/providers');
    const data = await res.json();
    rechargePackagesCents = data.rechargePackagesCents || rechargePackagesCents;
    jobPriceCents = data.jobPriceCents || jobPriceCents;
    wechatOAuthConfigured = !!data.wechat?.oauthConfigured;
    wechatOAuthMode = data.wechat?.oauthMode || 'offiaccount';
    localTestAccountEnabled = !!data.localTestAccount?.enabled;
    authServiceConfigured = !!data.authService?.configured;
    authServiceLoginUrl = data.authService?.loginUrl || '';
    authServiceWidgetConfigPath = data.authService?.widgetConfigPath || '';
    authServiceRedirectUri = data.authService?.redirectUri || '';
    nativePaymentConfigured = !!data.wechat?.nativePaymentConfigured;
    document.getElementById('wechatOAuthLoginBtn').classList.toggle('hidden', !wechatOAuthConfigured);
    document.getElementById('localTestLoginBtn').classList.toggle('hidden', !localTestAccountEnabled);
    document.getElementById('wechatLoginHint').textContent = wechatOAuthConfigured
      ? (localTestAccountEnabled
        ? '本地调试可用已充值测试账户；真实登录仍走微信。'
        : authServiceConfigured
        ? '使用微信扫码登录后余额会绑定到同一账户。'
        : (wechatOAuthMode === 'website' ? '使用微信扫码登录后余额会绑定到同一微信账户。' : '使用微信授权登录后余额会绑定到同一微信账户。'))
      : (localTestAccountEnabled ? '本地调试可使用已充值测试账户。' : '真实登录暂未配置，请联系管理员配置统一登录中心。');
    renderRechargeButtons();
    updateOptimizeButtonLabel();
  } catch (error) {
    console.warn('Account provider metadata unavailable:', error);
  }
}

async function refreshAccount() {
  if (!webToken) {
    currentWallet = null;
    document.getElementById('accountLoggedOut').classList.remove('hidden');
    document.getElementById('accountLoggedIn').classList.add('hidden');
    hideDownloadList();
    updateOptimizeButtonLabel();
    return;
  }
  try {
    const res = await fetch('/api/v1/account/me', { headers: getWebAuthHeaders() });
    if (!res.ok) throw new Error('web auth expired');
    const data = await res.json();
    displayAccount(data.user, data.wallet);
  } catch (error) {
    localStorage.removeItem('web_token');
    webToken = '';
    currentWallet = null;
    document.getElementById('accountLoggedOut').classList.remove('hidden');
    document.getElementById('accountLoggedIn').classList.add('hidden');
    hideDownloadList();
    updateOptimizeButtonLabel();
  }
}

async function loginWithLocalTestAccount() {
  const button = document.getElementById('localTestLoginBtn');
  button.disabled = true;
  try {
    const res = await fetch('/api/v1/account/auth/dev-login', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || '本地测试账户登录失败。');
    webToken = data.token;
    localStorage.setItem('web_token', webToken);
    errorMsg.classList.add('hidden');
    displayAccount(data.user, data.wallet);
  } catch (error) {
    showError(error.message);
  } finally {
    button.disabled = false;
  }
}

function displayWallet(wallet) {
  currentWallet = wallet;
  document.getElementById('cashBalance').textContent = formatMoney(wallet.cashBalanceCents);
  document.getElementById('frozenBalance').textContent = formatMoney(wallet.frozenCents);
  updateOptimizeButtonLabel();
}

function displayAccount(user, wallet) {
  document.getElementById('accountLoggedOut').classList.add('hidden');
  document.getElementById('accountLoggedIn').classList.remove('hidden');
  document.getElementById('accountNickname').textContent = user.nickname || user.wechatAccountHint || '微信用户';
  document.getElementById('accountTenantId').textContent = user.wechatAccountHint || `账号 ${shortAccountId(user)}`;
  const avatar = document.getElementById('accountAvatar');
  const placeholder = document.getElementById('accountAvatarPlaceholder');
  if (user.avatarUrl) {
    avatar.src = user.avatarUrl;
    avatar.classList.remove('hidden');
    placeholder.classList.add('hidden');
  } else {
    avatar.removeAttribute('src');
    avatar.classList.add('hidden');
    placeholder.classList.remove('hidden');
  }
  displayWallet(wallet);
  loadDownloadList();
}

function shortAccountId(user) {
  const source = user.authUserId || user.wechatUnionId || user.wechatOpenId || user.tenantId || '';
  return source ? source.slice(-8) : '已登录';
}

function hideDownloadList() {
  downloadListSection.classList.add('hidden');
  downloadList.innerHTML = '';
  downloadListEmpty.classList.add('hidden');
}

function formatRemainingTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '即将清理';
  const minutes = Math.ceil(ms / 60000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}

function renderDownloadList(files) {
  downloadList.innerHTML = '';
  downloadListEmpty.classList.toggle('hidden', files.length > 0);
  for (const file of files) {
    const item = document.createElement('div');
    item.className = 'download-item';

    const top = document.createElement('div');
    top.className = 'd-flex justify-content-between align-items-center gap-2';

    const title = document.createElement('div');
    title.className = 'fw-semibold small text-truncate';
    title.textContent = file.originalFilename || `任务 ${file.taskId.slice(0, 8)}`;

    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'btn btn-sm btn-outline-success flex-shrink-0';
    link.title = `优化时间：${new Date(file.optimizedAt).toLocaleString()}\n优化参数：${file.optionsDetail || file.optionsSummary || '未记录'}`;
    link.textContent = `下载 · 还剩 ${formatRemainingTime(file.remainingMs)}`;
    link.addEventListener('click', async () => {
      try {
        const downloaded = await fetchOptimizedFile(file.taskId);
        saveFile(downloaded);
      } catch (error) {
        showError(error.message);
      }
    });

    const meta = document.createElement('div');
    meta.className = 'download-meta mt-1';
    meta.textContent = `${formatSize(file.size)} · ${new Date(file.optimizedAt).toLocaleString()}`;

    top.append(title, link);
    item.append(top, meta);
    downloadList.appendChild(item);
  }
}

async function loadDownloadList() {
  if (!webToken) {
    hideDownloadList();
    return;
  }
  downloadListSection.classList.remove('hidden');
  downloadListEmpty.classList.add('hidden');
  downloadList.innerHTML = '<div class="text-muted small">正在加载可下载文件...</div>';
  try {
    const res = await fetch('/api/download', { headers: getWebAuthHeaders() });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || '下载列表加载失败');
    renderDownloadList(data.files || []);
  } catch (error) {
    downloadList.innerHTML = `<div class="text-danger small">${error.message}</div>`;
  }
}

function renderRechargeButtons() {
  const container = document.getElementById('rechargeButtons');
  container.innerHTML = rechargePackagesCents.map((amount) => (
    `<button class="btn btn-sm btn-outline-primary recharge-btn" data-amount="${amount}" ${nativePaymentConfigured ? '' : 'disabled'}>充值 ${formatMoney(amount)}</button>`
  )).join('');
  container.querySelectorAll('.recharge-btn').forEach((button) => {
    button.addEventListener('click', () => createRechargeOrder(Number(button.dataset.amount)));
  });
}

function updateOptimizeButtonLabel() {
  optimizeBtn.innerHTML = `<i class="bi bi-lightning-charge me-1"></i>开始优化 · ${formatMoney(jobPriceCents)}/次`;
}

function showWechatPayOrder(status, data) {
  status.innerHTML = '';
  const order = data.order || {};
  if (data.qrCodeSvg) {
    const label = document.createElement('div');
    label.className = 'fw-semibold text-center';
    label.textContent = `请用微信扫码支付 ${formatMoney(order.amountCents)}`;
    const qr = document.createElement('img');
    qr.className = 'pay-qr';
    qr.alt = '微信支付二维码';
    qr.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(data.qrCodeSvg)}`;
    const code = document.createElement('code');
    code.className = 'pay-code';
    code.textContent = order.codeUrl || '';
    status.append(label, qr, code);
    return;
  }
  status.textContent = order.codeUrl
    ? `请用微信扫码支付：${order.codeUrl}`
    : '订单已创建，生产微信支付二维码需要配置商户凭证后展示。';
}

function stopRechargePolling() {
  if (rechargePollTimer) {
    clearInterval(rechargePollTimer);
    rechargePollTimer = null;
  }
}

function renderPaidRecharge(status, result) {
  const order = result.order;
  const wallet = result.wallet;
  status.textContent = `充值成功：${formatMoney(order.amountCents)}`;
  displayWallet(wallet);
}

async function syncRechargeOrder(orderId, status) {
  const res = await fetch(`/api/v1/account/wallet/recharge-orders/${orderId}/sync`, {
    method: 'POST',
    headers: getWebAuthHeaders(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || '同步支付结果失败');
  if (data.order?.status === 'paid') {
    renderPaidRecharge(status, data);
    stopRechargePolling();
    return true;
  }
  return false;
}

function startRechargePolling(orderId, status) {
  stopRechargePolling();
  let attempts = 0;
  rechargePollTimer = setInterval(async () => {
    attempts += 1;
    try {
      await syncRechargeOrder(orderId, status);
    } catch (error) {
      if (attempts >= 60) {
        status.textContent = error.message;
        stopRechargePolling();
      }
    }
    if (attempts >= 60) stopRechargePolling();
  }, 3000);
}

async function createRechargeOrder(amountCents) {
  const status = document.getElementById('rechargeStatus');
  status.classList.remove('hidden');
  if (!nativePaymentConfigured) {
    status.textContent = '微信支付未配置，暂时不能充值。';
    return;
  }
  status.textContent = '正在创建微信支付订单...';
  try {
    const res = await fetch('/api/v1/account/wallet/recharge-orders', {
      method: 'POST',
      headers: { ...getWebAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountCents }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || '创建充值订单失败');
    showWechatPayOrder(status, data);
    if (data.order?.id) startRechargePolling(data.order.id, status);
  } catch (error) {
    status.textContent = error.message;
  }
}

document.getElementById('syncOutTradeNoBtn').addEventListener('click', async () => {
  const status = document.getElementById('rechargeStatus');
  const input = document.getElementById('syncOutTradeNoInput');
  const outTradeNo = input.value.trim();
  if (!outTradeNo) return;
  status.classList.remove('hidden');
  status.textContent = '正在同步账单...';
  try {
    const res = await fetch('/api/v1/account/wallet/recharge-orders/sync-by-out-trade-no', {
      method: 'POST',
      headers: { ...getWebAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ outTradeNo }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || '同步账单失败');
    if (data.order?.status === 'paid') {
      renderPaidRecharge(status, data);
    } else {
      status.textContent = `账单状态：${data.order?.status || '待支付'}`;
    }
  } catch (error) {
    status.textContent = error.message;
  }
});
refreshDownloadsBtn.addEventListener('click', loadDownloadList);

async function createAuthServiceLoginRequest() {
  const state = randomToken();
  const codeVerifier = randomToken();
  const codeChallenge = await sha256Base64Url(codeVerifier);
  const returnTo = `${window.location.origin}${window.location.pathname}${window.location.search}${window.location.hash}`;
  const callbackOrigin = authServiceRedirectUri ? new URL(authServiceRedirectUri).origin : window.location.origin;
  sessionStorage.setItem('auth_service_state', state);
  sessionStorage.setItem('auth_service_code_verifier', codeVerifier);
  sessionStorage.setItem('auth_service_return_to', returnTo);
  const loginUrl = new URL(authServiceLoginUrl);
  if (callbackOrigin === window.location.origin) {
    loginUrl.searchParams.set('return_to', returnTo);
  }
  loginUrl.searchParams.set('state', state);
  loginUrl.searchParams.set('code_challenge', codeChallenge);
  loginUrl.searchParams.set('code_challenge_method', 'S256');
  return { state, codeChallenge, returnTo, loginUrl: loginUrl.toString(), callbackOrigin };
}

function loadWechatLoginScript() {
  if (window.WxLogin) return Promise.resolve(window.WxLogin);
  if (wechatLoginScriptPromise) return wechatLoginScriptPromise;
  wechatLoginScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://res.wx.qq.com/connect/zh_CN/htmledition/js/wxLogin.js';
    script.async = true;
    script.onload = () => window.WxLogin ? resolve(window.WxLogin) : reject(new Error('微信扫码组件加载失败。'));
    script.onerror = () => reject(new Error('微信扫码组件加载失败。'));
    document.head.appendChild(script);
  });
  return wechatLoginScriptPromise;
}

function showWechatLoginModalSkeleton(message) {
  const modalEl = document.getElementById('wechatLoginModal');
  const qr = document.getElementById('wechatLoginQr');
  const status = document.getElementById('wechatLoginStatus');
  qr.innerHTML = '<div class="spinner-border spinner-border-sm text-success" role="status"></div>';
  status.textContent = message || '正在加载微信二维码...';
  bootstrap.Modal.getOrCreateInstance(modalEl).show();
}

function stopWechatLoginPolling() {
  if (wechatLoginPollTimer) {
    clearInterval(wechatLoginPollTimer);
    wechatLoginPollTimer = null;
  }
}

async function pollOfficialQrLogin(widgetConfig) {
  const res = await fetch('/api/v1/account/auth/service/scan-status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: widgetConfig.token, state: widgetConfig.state }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || '扫码状态同步失败。');
  if (data.status !== 'confirmed') return false;
  if (!data.redirectUrl) throw new Error('统一登录中心没有返回授权回调。');

  stopWechatLoginPolling();
  document.getElementById('wechatLoginStatus').textContent = '扫码成功，正在登录...';
  const consumed = await consumeAuthServiceCallbackFromUrl(data.redirectUrl);
  if (!consumed) window.location.href = data.redirectUrl;
  bootstrap.Modal.getOrCreateInstance(document.getElementById('wechatLoginModal')).hide();
  return true;
}

function startOfficialQrPolling(widgetConfig) {
  stopWechatLoginPolling();
  const status = document.getElementById('wechatLoginStatus');
  const intervalMs = widgetConfig.pollIntervalMs || 2000;
  const maxAttempts = Math.max(1, Math.ceil(((widgetConfig.expiresIn || 300) * 1000) / intervalMs));
  let attempts = 0;
  wechatLoginPollTimer = setInterval(async () => {
    attempts += 1;
    try {
      await pollOfficialQrLogin(widgetConfig);
    } catch (error) {
      stopWechatLoginPolling();
      status.textContent = error.message || '微信扫码登录失败。';
      return;
    }
    if (attempts >= maxAttempts) {
      stopWechatLoginPolling();
      status.textContent = '二维码已过期，请重新打开微信登录。';
    }
  }, intervalMs);
}

async function renderWechatLoginModal(widgetConfig) {
  showWechatLoginModalSkeleton('正在加载微信二维码...');
  stopWechatLoginPolling();
  if (widgetConfig.mode === 'mock' && widgetConfig.callbackUrl) {
    window.location.href = widgetConfig.callbackUrl;
    return;
  }
  if (widgetConfig.mode === 'official_qr') {
    if (!widgetConfig.qrImageUrl || !widgetConfig.token || !widgetConfig.state) {
      throw new Error('统一登录中心没有返回完整的公众号扫码配置。');
    }
    const qr = document.getElementById('wechatLoginQr');
    const status = document.getElementById('wechatLoginStatus');
    qr.innerHTML = '';
    const image = document.createElement('img');
    image.src = widgetConfig.qrImageUrl;
    image.alt = '微信登录二维码';
    qr.appendChild(image);
    status.textContent = '请使用微信扫码登录';
    startOfficialQrPolling(widgetConfig);
    return;
  }
  if (!widgetConfig.appId || !widgetConfig.redirectUri || !widgetConfig.state) {
    throw new Error('统一登录中心没有返回完整的微信扫码配置。');
  }

  await loadWechatLoginScript();
  const qr = document.getElementById('wechatLoginQr');
  const status = document.getElementById('wechatLoginStatus');
  qr.innerHTML = '';
  status.textContent = '请使用微信扫码登录';
  new window.WxLogin({
    self_redirect: widgetConfig.selfRedirect === true,
    id: 'wechatLoginQr',
    appid: widgetConfig.appId,
    scope: widgetConfig.scope || 'snsapi_login',
    redirect_uri: encodeURIComponent(widgetConfig.redirectUri),
    state: widgetConfig.state,
    style: 'black',
    href: '',
  });
}

async function startAuthServiceLogin() {
  const request = await createAuthServiceLoginRequest();
  if (!authServiceWidgetConfigPath) {
    window.location.href = request.loginUrl;
    return;
  }

  showWechatLoginModalSkeleton('正在向统一登录中心请求二维码...');
  try {
    const res = await fetch(authServiceWidgetConfigPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        state: request.state,
        codeChallenge: request.codeChallenge,
        returnTo: request.callbackOrigin === window.location.origin ? request.returnTo : undefined,
      }),
    });
    const widgetConfig = await res.json();
    if (!res.ok) throw new Error(widgetConfig.error?.message || '微信扫码登录配置加载失败。');
    await renderWechatLoginModal(widgetConfig);
  } catch (error) {
    document.getElementById('wechatLoginQr').innerHTML = '<i class="bi bi-exclamation-circle text-warning" style="font-size:2rem;"></i>';
    document.getElementById('wechatLoginStatus').textContent = error.message === 'not_found'
      ? '统一登录中心还没有部署扫码登录组件，请先更新 auth-service。'
      : (error.message || '微信扫码登录暂不可用。');
  }
}

document.getElementById('wechatLoginModal').addEventListener('hidden.bs.modal', stopWechatLoginPolling);

document.getElementById('wechatOAuthLoginBtn').addEventListener('click', async () => {
  if (authServiceConfigured && authServiceLoginUrl) {
    try {
      await startAuthServiceLogin();
    } catch (error) {
      showError(error.message);
    }
    return;
  }
  const returnTo = `${window.location.pathname}${window.location.search}`;
  window.location.href = `/api/v1/account/auth/wechat/authorize?returnTo=${encodeURIComponent(returnTo || '/')}`;
});
document.getElementById('localTestLoginBtn').addEventListener('click', loginWithLocalTestAccount);
document.getElementById('logoutWebUserBtn').addEventListener('click', () => {
  webToken = '';
  localStorage.removeItem('web_token');
  refreshAccount();
});
consumeWebTokenFromUrl();
(async () => {
  await consumeAuthServiceCallbackFromUrl();
  await loadAccountProviders();
  await refreshAccount();
})();

// ===== Three.js =====
function createScene(container) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xe9ecef);
  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const d1 = new THREE.DirectionalLight(0xffffff, 0.9); d1.position.set(5, 10, 7); scene.add(d1);
  const d2 = new THREE.DirectionalLight(0xffffff, 0.3); d2.position.set(-5, -5, -5); scene.add(d2);
  scene.add(new THREE.GridHelper(10, 20, 0xced4da, 0xdee2e6));
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
  camera.position.set(3, 2, 3);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  container.appendChild(renderer.domElement);
  // Size to actual container
  const w = container.clientWidth || 400, h = container.clientHeight || 400;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.05;
  return { scene, camera, renderer, controls };
}

function initViewers() {
  const lp = document.getElementById('viewerLeft'), rp = document.getElementById('viewerRight');
  const l = createScene(lp); leftScene = l.scene; leftCamera = l.camera; leftRenderer = l.renderer; leftControls = l.controls;
  const r = createScene(rp); rightScene = r.scene; rightCamera = r.camera; rightRenderer = r.renderer; rightControls = r.controls;
  let syncing = false;
  leftControls.addEventListener('change', () => {
    if (syncing || !document.getElementById('syncCameras').checked) return;
    syncing = true;
    rightCamera.position.copy(leftCamera.position); rightCamera.rotation.copy(leftCamera.rotation); rightControls.target.copy(leftControls.target); rightControls.update();
    syncing = false;
  });
  rightControls.addEventListener('change', () => {
    if (syncing || !document.getElementById('syncCameras').checked) return;
    syncing = true;
    leftCamera.position.copy(rightCamera.position); leftCamera.rotation.copy(rightCamera.rotation); leftControls.target.copy(rightControls.target); leftControls.update();
    syncing = false;
  });
  // Use ResizeObserver for reliable sizing
  const ro = new ResizeObserver(() => onResize());
  ro.observe(lp);
  ro.observe(rp);
  // Delay first resize to let layout settle
  requestAnimationFrame(() => { onResize(); animate(); });
}

function animate() { requestAnimationFrame(animate); leftControls.update(); rightControls.update(); leftRenderer.render(leftScene, leftCamera); rightRenderer.render(rightScene, rightCamera); }

function onResize() {
  const lp = document.getElementById('viewerLeft'), rp = document.getElementById('viewerRight');
  if (leftRenderer && lp.clientWidth > 0 && lp.clientHeight > 0) { leftCamera.aspect = lp.clientWidth / lp.clientHeight; leftCamera.updateProjectionMatrix(); leftRenderer.setSize(lp.clientWidth, lp.clientHeight, false); }
  if (rightRenderer && rp.clientWidth > 0 && rp.clientHeight > 0) { rightCamera.aspect = rp.clientWidth / rp.clientHeight; rightCamera.updateProjectionMatrix(); rightRenderer.setSize(rp.clientWidth, rp.clientHeight, false); }
}
window.addEventListener('resize', onResize);

function createGltfLoader(side) {
  const loader = new GLTFLoader();
  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath(DRACO_DECODER_PATH);
  loader.setDRACOLoader(dracoLoader);

  const renderer = side === 'left' ? leftRenderer : rightRenderer;
  if (renderer) {
    const ktx2Loader = new KTX2Loader();
    ktx2Loader.setTranscoderPath(KTX2_TRANSCODER_PATH);
    ktx2Loader.detectSupport(renderer);
    loader.setKTX2Loader(ktx2Loader);
  }

  return loader;
}

function loadModelFromFile(file, scene, side) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const ext = file.name.split('.').pop().toLowerCase();
    const onLoad = (obj) => {
      let model = obj.scene || obj;
      const box = new THREE.Box3().setFromObject(model);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      const scale = 3 / maxDim;
      model.scale.setScalar(scale);
      model.position.sub(center.multiplyScalar(scale));
      model.position.y -= (box.min.y * scale);
      scene.add(model);
      let tris = 0, verts = 0;
      model.traverse(child => { if (child.isMesh && child.geometry) { const g = child.geometry; tris += g.index ? g.index.count / 3 : (g.attributes.position?.count || 0) / 3; verts += g.attributes.position?.count || 0; } });
      document.getElementById(side === 'left' ? 'infoLeft' : 'infoRight').textContent = `△ ${Math.round(tris).toLocaleString()} | ⬡ ${Math.round(verts).toLocaleString()}`;
      URL.revokeObjectURL(url); resolve(model);
    };
    if (ext === 'glb' || ext === 'gltf') {
      createGltfLoader(side).load(url, onLoad, undefined, reject);
    } else if (ext === 'obj') {
      new OBJLoader().load(url, (obj) => { obj.traverse(c => { if (c.isMesh) c.material = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.6, metalness: 0.2 }); }); onLoad(obj); }, undefined, reject);
    } else if (ext === 'stl') {
      new STLLoader().load(url, (geo) => { geo.computeVertexNormals(); const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.6, metalness: 0.2 })); const g = new THREE.Group(); g.add(m); onLoad(g); }, undefined, reject);
    } else if (ext === 'usdz') {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const loader = new USDZLoader();
          const group = loader.parse(reader.result);
          group.traverse(c => { if (c.isMesh && !c.material) c.material = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.6, metalness: 0.2 }); });
          onLoad(group);
        } catch (e) { reject(e); }
      };
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
      URL.revokeObjectURL(url);
      return;
    } else { URL.revokeObjectURL(url); reject(new Error('Format not supported for preview')); }
  });
}

function loadModelFromUrl(url, scene, side) {
  return new Promise((resolve, reject) => {
    createGltfLoader(side).load(url, (gltf) => {
      const model = gltf.scene;
      const box = new THREE.Box3().setFromObject(model); const center = box.getCenter(new THREE.Vector3()); const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z); const scale = 3 / maxDim;
      model.scale.setScalar(scale); model.position.sub(center.multiplyScalar(scale)); model.position.y -= (box.min.y * scale);
      scene.add(model);
      let tris = 0, verts = 0;
      model.traverse(child => { if (child.isMesh && child.geometry) { const g = child.geometry; tris += g.index ? g.index.count / 3 : (g.attributes.position?.count || 0) / 3; verts += g.attributes.position?.count || 0; } });
      document.getElementById(side === 'left' ? 'infoLeft' : 'infoRight').textContent = `△ ${Math.round(tris).toLocaleString()} | ⬡ ${Math.round(verts).toLocaleString()}`;
      resolve(model);
    }, undefined, reject);
  });
}

function clearModel(scene, model) {
  if (model) { scene.remove(model); model.traverse(c => { if (c.geometry) c.geometry.dispose(); if (c.material) { if (Array.isArray(c.material)) c.material.forEach(m => m.dispose()); else c.material.dispose(); } }); }
  return null;
}
function fitCamera(camera, controls, model) {
  if (!model) return;
  const box = new THREE.Box3().setFromObject(model); const center = box.getCenter(new THREE.Vector3()); const size = box.getSize(new THREE.Vector3());
  const dist = Math.max(size.x, size.y, size.z) * 1.5;
  camera.position.set(center.x + dist, center.y + dist * 0.6, center.z + dist); controls.target.copy(center); controls.update();
}
function toggleWireframe(model, enabled) {
  if (!model) return;
  model.traverse(c => { if (c.isMesh && c.material) { (Array.isArray(c.material) ? c.material : [c.material]).forEach(m => { m.wireframe = enabled; }); } });
}

// ===== Toolbar =====
document.getElementById('btnSplit').addEventListener('click', () => setViewMode('split'));
document.getElementById('btnOriginal').addEventListener('click', () => setViewMode('original'));
document.getElementById('btnOptimized').addEventListener('click', () => setViewMode('optimized'));
function setViewMode(mode) {
  viewMode = mode;
  const left = document.getElementById('viewerLeft'), right = document.getElementById('viewerRight'), divider = document.getElementById('viewerDivider');
  document.querySelectorAll('.btn-group .btn').forEach(b => b.classList.remove('active'));
  if (mode === 'split') { left.style.display = ''; right.style.display = ''; divider.style.display = ''; document.getElementById('btnSplit').classList.add('active'); }
  else if (mode === 'original') { left.style.display = ''; right.style.display = 'none'; divider.style.display = 'none'; document.getElementById('btnOriginal').classList.add('active'); }
  else { left.style.display = 'none'; right.style.display = ''; divider.style.display = 'none'; document.getElementById('btnOptimized').classList.add('active'); }
  setTimeout(onResize, 50);
}
document.getElementById('btnWireframe').addEventListener('click', function() { wireframeMode = !wireframeMode; this.classList.toggle('active', wireframeMode); toggleWireframe(leftModel, wireframeMode); toggleWireframe(rightModel, wireframeMode); });
document.getElementById('btnResetCamera').addEventListener('click', () => { if (leftModel) fitCamera(leftCamera, leftControls, leftModel); if (rightModel) fitCamera(rightCamera, rightControls, rightModel); });

function requireLoginForAction(action) {
  if (webToken) return true;
  showError(`请先登录账号后再${action}。`);
  return false;
}

// ===== Upload =====
uploadArea.addEventListener('click', () => { if (requireLoginForAction('上传模型')) fileInput.click(); });
uploadArea.addEventListener('dragover', (e) => { e.preventDefault(); uploadArea.classList.add('dragover'); });
uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
uploadArea.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadArea.classList.remove('dragover');
  if (e.dataTransfer.files[0] && requireLoginForAction('上传模型')) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', (e) => {
  if (e.target.files[0] && requireLoginForAction('上传模型')) handleFile(e.target.files[0]);
});

async function handleFile(file) {
  if (!requireLoginForAction('上传模型')) return;
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['glb','gltf','obj','stl','fbx','usdz','dae','step','stp','prt','catpart','catproduct','asm'].includes(ext)) { alert('不支持的文件格式'); return; }
  if (file.size > 100 * 1024 * 1024) { alert('文件超过 100MB'); return; }
  selectedFile = file;
  fileName.textContent = `${file.name} (${formatSize(file.size)})`;
  modelInfoSection.classList.add('hidden'); optionsSection.classList.add('hidden'); resultSection.classList.add('hidden'); errorMsg.classList.add('hidden'); optimizeBtn.disabled = true;
  leftModel = clearModel(leftScene, leftModel); document.getElementById('placeholderLeft').style.display = 'none'; document.getElementById('infoLeft').textContent = '';
  const clientPreviewFormats = ['glb', 'gltf', 'obj', 'stl', 'usdz'];
  if (clientPreviewFormats.includes(ext)) {
    try { leftModel = await loadModelFromFile(file, leftScene, 'left'); fitCamera(leftCamera, leftControls, leftModel); if (wireframeMode) toggleWireframe(leftModel, true); } catch (e) { console.warn('Preview not available:', e); }
  } else {
    document.getElementById('placeholderLeft').style.display = 'flex';
    document.getElementById('placeholderLeft').innerHTML = '<span class="text-muted"><i class="bi bi-eye-slash me-2"></i>' + ext.toUpperCase() + ' 格式不支持客户端预览，优化后可查看 GLB</span>';
  }
  rightModel = clearModel(rightScene, rightModel); document.getElementById('placeholderRight').style.display = 'flex'; document.getElementById('infoRight').textContent = '';
  await analyzeFile(file);
}

async function analyzeFile(file) {
  analyzeLoading.classList.add('show');
  const fd = new FormData(); fd.append('file', file);
  try {
    const res = await fetch('/api/analyze', { method: 'POST', body: fd, headers: getWebAuthHeaders() });
    const data = await res.json();
    if (data.success) { modelAnalysis = data.analysis; displayModelInfo(data.analysis); modelInfoSection.classList.remove('hidden'); optionsSection.classList.remove('hidden'); optimizeBtn.disabled = false; updateHints(data.analysis); }
    else showError(`分析失败: ${data.error?.message || '未知错误'}`);
  } catch (err) { showError(`分析请求失败: ${err.message}`); }
  finally { analyzeLoading.classList.remove('show'); }
}

function displayModelInfo(a) {
  document.getElementById('summaryBadges').innerHTML = `<span class="badge ${a.hasDraco ? 'text-bg-success' : 'text-bg-warning'} me-1">${a.hasDraco ? '✓ Draco' : '✗ Draco'}</span><span class="badge ${a.hasKTX2 ? 'text-bg-info' : 'text-bg-danger'}">${a.hasKTX2 ? '✓ KTX2' : '✗ KTX2'}</span>`;
  document.getElementById('basicInfo').innerHTML = `<div class="info-row"><span class="info-label">大小</span><span class="info-value">${formatSize(a.fileSize)}</span></div><div class="info-row"><span class="info-label">格式</span><span class="info-value">${a.format}</span></div><div class="info-row"><span class="info-label">节点</span><span class="info-value">${a.nodes}</span></div><div class="info-row"><span class="info-label">纹理</span><span class="info-value">${a.textures.count} (${formatSize(a.textures.totalSize)})</span></div>`;
  document.getElementById('meshInfo').innerHTML = `<div class="info-row"><span class="info-label">网格</span><span class="info-value">${a.meshes.count}</span></div><div class="info-row"><span class="info-label">三角形</span><span class="info-value">${a.meshes.totalTriangles.toLocaleString()}</span></div><div class="info-row"><span class="info-label">顶点</span><span class="info-value">${a.meshes.totalVertices.toLocaleString()}</span></div>`;
}
function updateHints(a) {
  document.getElementById('dracoHint').classList.toggle('hidden', !a.hasDraco);
  document.getElementById('ktx2Hint').classList.toggle('hidden', !a.hasKTX2);
}

// ===== Optimization mode =====
let activeOptimizationMode = 'default';
const defaultOptimizationOptions = {
  clean: true,
  removeUnusedNodes: true,
  removeUnusedMaterials: true,
  removeUnusedTextures: true,
  merge: true,
  simplify: false,
  ratio: 0.5,
  lockBorder: false,
  quantize: false,
  draco: true,
  dracoLevel: 7,
  texture: true,
  texMode: 'ETC1S',
  preserveUnlit: true,
};

function applyOptimizationOptions(options) {
  document.getElementById('cleanEnabled').checked = options.clean;
  document.getElementById('removeUnusedNodes').checked = options.removeUnusedNodes;
  document.getElementById('removeUnusedMaterials').checked = options.removeUnusedMaterials;
  document.getElementById('removeUnusedTextures').checked = options.removeUnusedTextures;
  document.getElementById('mergeEnabled').checked = options.merge;
  document.getElementById('simplifyEnabled').checked = options.simplify;
  document.getElementById('targetRatio').value = options.ratio;
  document.getElementById('lockBorder').checked = options.lockBorder;
  document.getElementById('quantizeEnabled').checked = options.quantize;
  document.getElementById('dracoEnabled').checked = options.draco;
  document.getElementById('compressionLevel').value = options.dracoLevel;
  document.getElementById('textureEnabled').checked = options.texture;
  document.getElementById('textureMode').value = options.texMode;
  document.getElementById('preserveUnlitEnabled').checked = options.preserveUnlit;
}

function setOptimizationMode(mode) {
  activeOptimizationMode = mode;
  document.querySelectorAll('.optimization-mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.optimizationMode === mode);
  });
  document.getElementById('customOptions').classList.toggle('hidden', mode !== 'custom');
  if (mode === 'default') applyOptimizationOptions(defaultOptimizationOptions);
}

document.querySelectorAll('.optimization-mode-btn').forEach(btn => {
  btn.addEventListener('click', function() {
    setOptimizationMode(this.dataset.optimizationMode);
  });
});
applyOptimizationOptions(defaultOptimizationOptions);
setOptimizationMode(activeOptimizationMode);

// ===== Optimize (SSE with progress) =====
optimizeBtn.addEventListener('click', async () => {
  if (!selectedFile) return;
  if (!requireLoginForAction('优化模型')) return;
  loading.classList.add('show'); resultSection.classList.add('hidden'); errorMsg.classList.add('hidden'); optimizeBtn.disabled = true;
  document.getElementById('progressSteps').innerHTML = '';
  document.getElementById('loadingText').textContent = '优化处理中...';

  const fd = new FormData(); fd.append('file', selectedFile);
  fd.append('options', JSON.stringify(getOptions()));

  try {
    const res = await fetch('/api/optimize/stream', { method: 'POST', body: fd, headers: getWebAuthHeaders() });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.error?.message || '优化请求失败');
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalResult = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      let currentEvent = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) currentEvent = line.slice(7);
        else if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            if (currentEvent === 'progress') {
              const stepsEl = document.getElementById('progressSteps');
              const stepId = `step-${data.step}`;
              let el = document.getElementById(stepId);
              if (data.status === 'start') {
                if (!el) {
                  el = document.createElement('div');
                  el.id = stepId;
                  el.className = 'step-item';
                  stepsEl.appendChild(el);
                }
                el.innerHTML = `<span class="step-icon bg-warning-subtle text-warning"><div class="spinner-border spinner-border-sm" style="width:12px;height:12px;border-width:2px;"></div></span><span class="flex-grow-1">${data.stepName || data.step}</span>`;
                document.getElementById('loadingText').textContent = `正在执行: ${data.stepName || data.step}`;
              } else if (data.status === 'done') {
                if (el) el.innerHTML = `<span class="step-icon bg-success-subtle text-success">✓</span><span class="flex-grow-1">${data.stepName || data.step}</span><span class="text-muted small">${data.duration || 0}ms</span>`;
              } else if (data.status === 'error') {
                if (el) el.innerHTML = `<span class="step-icon bg-danger-subtle text-danger">✗</span><span class="flex-grow-1">${data.stepName || data.step}</span><span class="text-danger small">${data.error || ''}</span>`;
              }
            } else if (currentEvent === 'result') {
              finalResult = data;
            } else if (currentEvent === 'wallet') {
              if (data.wallet) displayWallet(data.wallet);
            } else if (currentEvent === 'error') {
              showError(`优化失败: ${data.message || '未知错误'}`);
            }
          } catch (e) {}
        }
      }
    }

    if (finalResult && finalResult.success) {
      if (finalResult.wallet) displayWallet(finalResult.wallet);
      currentTaskId = finalResult.taskId; displayResult(finalResult); resultSection.classList.remove('hidden');
      loadDownloadList();
      rightModel = clearModel(rightScene, rightModel); document.getElementById('placeholderRight').style.display = 'none';
      try {
        const optimizedFile = await fetchOptimizedFile(finalResult.taskId);
        rightModel = await loadModelFromFile(optimizedFile, rightScene, 'right'); fitCamera(rightCamera, rightControls, rightModel);
        if (wireframeMode) toggleWireframe(rightModel, true);
        if (document.getElementById('syncCameras').checked && leftModel) { rightCamera.position.copy(leftCamera.position); rightCamera.rotation.copy(leftCamera.rotation); rightControls.target.copy(leftControls.target); rightControls.update(); }
      } catch (e) { console.warn('Could not load optimized preview:', e); document.getElementById('placeholderRight').style.display = 'flex'; document.getElementById('placeholderRight').textContent = '预览不可用'; }
    } else if (finalResult) {
      showError(`优化失败: ${finalResult.error || '未知错误'}`);
    }
  } catch (err) { showError(`请求失败: ${err.message}`); }
  finally { loading.classList.remove('show'); optimizeBtn.disabled = false; }
});

function displayResult(data) {
  const orig = data.originalSize, opt = data.optimizedSize, saved = orig - opt;
  document.getElementById('originalSize').textContent = formatSize(orig);
  document.getElementById('optimizedSize').textContent = formatSize(opt);
  document.getElementById('savedSize').textContent = (saved >= 0 ? '-' : '+') + formatSize(Math.abs(saved));
  document.getElementById('compressionRatio').textContent = (data.compressionRatio * 100).toFixed(1) + '%';
  downloadBtn.title = data.optionsDetail || data.optionsSummary ? `优化参数：\n${data.optionsDetail || data.optionsSummary}` : '优化参数未记录';
  let html = '';
  if (data.reused) html += `<div class="alert alert-success small py-2 mb-2">${data.message || '已找到相同模型和参数的历史结果，未重新扣费，可直接下载上一个模型。'}</div>`;
  if (data.conversion?.converted) html += `<div class="step-item"><span class="step-icon bg-success-subtle text-success">✓</span><span class="flex-grow-1">格式转换 (${data.conversion.originalFormat} → GLB)</span><span class="text-muted small">${data.conversion.conversionTime}ms</span></div>`;
  html += (data.steps || []).map(s => `<div class="step-item"><span class="step-icon ${s.success ? 'bg-success-subtle text-success' : 'bg-danger-subtle text-danger'}">${s.success ? '✓' : '✗'}</span><span class="flex-grow-1">${s.step}</span><span class="text-muted small">${s.duration}ms</span></div>`).join('');
  document.getElementById('stepsList').innerHTML = html;
}

async function fetchOptimizedFile(taskId) {
  const res = await fetch(`/api/download/${taskId}`, { headers: getWebAuthHeaders() });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error?.message || '下载优化文件失败');
  }
  const blob = await res.blob();
  return new File([blob], `optimized-${taskId}.glb`, { type: blob.type || 'model/gltf-binary' });
}

function saveFile(file) {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

downloadBtn.addEventListener('click', async () => {
  if (!currentTaskId) return;
  try {
    const file = await fetchOptimizedFile(currentTaskId);
    saveFile(file);
  } catch (error) {
    showError(error.message);
  }
});

function formatSize(bytes) { if (!bytes) return '0 B'; if (bytes < 1024) return bytes + ' B'; if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'; return (bytes / (1024 * 1024)).toFixed(2) + ' MB'; }
function getOptions() {
  const o = {};
  o.extensions = { preserveUnlit: document.getElementById('preserveUnlitEnabled').checked };
  if (document.getElementById('cleanEnabled').checked) o.clean = { enabled: true, removeUnusedNodes: document.getElementById('removeUnusedNodes').checked, removeUnusedMaterials: document.getElementById('removeUnusedMaterials').checked, removeUnusedTextures: document.getElementById('removeUnusedTextures').checked };
  if (document.getElementById('mergeEnabled').checked) o.merge = { enabled: true };
  if (document.getElementById('simplifyEnabled').checked) o.simplify = { enabled: true, targetRatio: parseFloat(document.getElementById('targetRatio').value), lockBorder: document.getElementById('lockBorder').checked };
  if (document.getElementById('quantizeEnabled').checked) o.quantize = { enabled: true };
  if (document.getElementById('dracoEnabled').checked) o.draco = { enabled: true, compressionLevel: parseInt(document.getElementById('compressionLevel').value) };
  if (document.getElementById('textureEnabled').checked) o.texture = { enabled: true, mode: document.getElementById('textureMode').value };
  return o;
}
function showError(msg) { errorMsg.textContent = msg; errorMsg.classList.remove('hidden'); }

renderBuildVersion();
initViewers();
onResize();
