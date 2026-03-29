addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

const CONFIG = { 
  KV_TTL: 3600,
  RATE_LIMIT_SECONDS: 60, // 1分钟频率限制
  DELAY_SECONDS: 30       // 无位置延迟30秒
}

// 车牌配置 - 每个二维码绑定一个车牌
// 格式: 二维码ID -> 车牌号
const PLATE_BINDINGS = {
  'default': '京A12345',  // 默认车牌，建议修改为实际车牌
  // 示例: 'abc123': '京B88888',
  // 示例: 'xyz789': '沪C66666',
}

async function handleRequest(request) {
  const url = new URL(request.url)
  const path = url.pathname
  const plateId = url.searchParams.get('plate') || 'default'
  // 优先使用环境变量中的车牌配置
  const boundPlate = typeof self.PLATE_BINDINGS !== 'undefined' ? self.PLATE_BINDINGS : (PLATE_BINDINGS[plateId] || PLATE_BINDINGS['default'])

  // API 路由
  if (path === '/api/verify-plate' && request.method === 'POST') {
    return handleVerifyPlate(request, boundPlate)
  }

  if (path === '/api/notify' && request.method === 'POST') {
    return handleNotify(request, url, plateId)
  }

  if (path === '/api/check-status') {
    return handleCheckStatus(request, plateId)
  }

  if (path === '/api/get-location') {
    return handleGetLocation(plateId)
  }

  if (path === '/api/owner-confirm' && request.method === 'POST') {
    return handleOwnerConfirmAction(request, plateId)
  }

  // 页面路由
  if (path === '/owner-confirm') {
    return renderOwnerPage(boundPlate)
  }

  // 主页面 - 带车牌参数
  return renderMainPage(url.origin, boundPlate, plateId)
}

// 处理车牌验证
async function handleVerifyPlate(request, boundPlate) {
  try {
    const body = await request.json()
    const inputPlate = body.plate || ''
    
    // 标准化车牌（去除空格，转大写）
    const normalizedInput = inputPlate.replace(/\s/g, '').toUpperCase()
    const normalizedBound = boundPlate.replace(/\s/g, '').toUpperCase()
    
    const isValid = normalizedInput === normalizedBound
    
    return new Response(JSON.stringify({ 
      success: isValid,
      message: isValid ? '验证通过' : '车牌号不匹配，请确认后重试'
    }), {
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error) {
    return new Response(JSON.stringify({ 
      success: false, 
      message: '验证失败，请重试'
    }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

// WGS-84 转 GCJ-02 (中国国测局坐标系)
function wgs84ToGcj02(lat, lng) {
  const a = 6378245.0;
  const ee = 0.00669342162296594323;

  if (outOfChina(lat, lng)) return { lat, lng };

  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = lat / 180.0 * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((a * (1 - ee)) / (magic * sqrtMagic) * Math.PI);
  dLng = (dLng * 180.0) / (a / sqrtMagic * Math.cos(radLat) * Math.PI);
  return { lat: lat + dLat, lng: lng + dLng };
}

function outOfChina(lat, lng) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
  return ret;
}

function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
  return ret;
}

function generateMapUrls(lat, lng) {
  const gcj = wgs84ToGcj02(lat, lng);
  return {
    amapUrl: `https://uri.amap.com/marker?position=${gcj.lng},${gcj.lat}&name=位置`,
    appleUrl: `https://maps.apple.com/?ll=${gcj.lat},${gcj.lng}&q=位置`
  };
}

// 获取请求者IP/标识
function getRequesterId(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown'
}

// 检查频率限制
async function checkRateLimit(requesterId, plateId) {
  const key = `rate_limit:${plateId}:${requesterId}`
  const lastRequest = await MOVE_CAR_STATUS.get(key)
  
  if (lastRequest) {
    const lastTime = parseInt(lastRequest)
    const now = Date.now()
    const elapsed = Math.floor((now - lastTime) / 1000)
    
    if (elapsed < CONFIG.RATE_LIMIT_SECONDS) {
      const remaining = CONFIG.RATE_LIMIT_SECONDS - elapsed
      return { allowed: false, remaining }
    }
  }
  
  return { allowed: true, remaining: 0 }
}

// 更新频率限制
async function updateRateLimit(requesterId, plateId) {
  const key = `rate_limit:${plateId}:${requesterId}`
  await MOVE_CAR_STATUS.put(key, Date.now().toString(), { expirationTtl: CONFIG.RATE_LIMIT_SECONDS * 2 })
}

// 检查请求是否已关闭
async function isRequestClosed(plateId) {
  const status = await MOVE_CAR_STATUS.get(`status:${plateId}`)
  return status === 'closed'
}

// 关闭请求链路
async function closeRequest(plateId) {
  await MOVE_CAR_STATUS.put(`status:${plateId}`, 'closed', { expirationTtl: 600 })
}

async function handleNotify(request, url, plateId) {
  try {
    const requesterId = getRequesterId(request)
    
    // 检查请求是否已关闭
    const closed = await isRequestClosed(plateId)
    if (closed) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: '该请求已处理完毕，无法再次发送通知',
        closed: true
      }), { 
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      })
    }
    
    // 检查频率限制
    const rateCheck = await checkRateLimit(requesterId, plateId)
    if (!rateCheck.allowed) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: '发送太频繁，请稍后再试',
        retryAfter: rateCheck.remaining
      }), { 
        status: 429,
        headers: { 'Content-Type': 'application/json' }
      })
    }
    
    const body = await request.json()
    const message = body.message || '车旁有人等待'
    const location = body.location || null
    const delayed = body.delayed || false
    const boundPlate = body.boundPlate || ''

    const confirmUrl = encodeURIComponent(url.origin + '/owner-confirm?plate=' + plateId)

    let notifyBody = `🚗 挪车请求\n🚙 车牌: ${boundPlate}`
    if (message) notifyBody += `\n💬 留言: ${message}`

    if (location && location.lat && location.lng) {
      const urls = generateMapUrls(location.lat, location.lng)
      notifyBody += '\n📍 已附带位置信息，点击查看'

      await MOVE_CAR_STATUS.put(`requester_location:${plateId}`, JSON.stringify({
        lat: location.lat,
        lng: location.lng,
        ...urls
      }), { expirationTtl: CONFIG.KV_TTL })
    } else {
      notifyBody += '\n⚠️ 未提供位置信息'
    }

    await MOVE_CAR_STATUS.put(`notify_status:${plateId}`, 'waiting', { expirationTtl: 600 })
    
    // 更新频率限制
    await updateRateLimit(requesterId, plateId)

    // 如果是延迟发送，等待30秒
    if (delayed) {
      await new Promise(resolve => setTimeout(resolve, CONFIG.DELAY_SECONDS * 1000))
    }

    const barkApiUrl = `${BARK_URL}/挪车请求/${encodeURIComponent(notifyBody)}?group=MoveCar&level=critical&call=1&sound=minuet&icon=https://cdn-icons-png.flaticon.com/512/741/741407.png&url=${confirmUrl}`

    const barkResponse = await fetch(barkApiUrl)
    if (!barkResponse.ok) throw new Error('Bark API Error')

    return new Response(JSON.stringify({ 
      success: true,
      delayed: delayed,
      nextAvailableIn: CONFIG.RATE_LIMIT_SECONDS
    }), {
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

async function handleCheckStatus(request, plateId) {
  const status = await MOVE_CAR_STATUS.get(`notify_status:${plateId}`)
  const ownerLocation = await MOVE_CAR_STATUS.get(`owner_location:${plateId}`)
  const isClosed = await isRequestClosed(plateId)
  
  return new Response(JSON.stringify({
    status: status || 'waiting',
    ownerLocation: ownerLocation ? JSON.parse(ownerLocation) : null,
    closed: isClosed
  }), {
    headers: { 'Content-Type': 'application/json' }
  })
}

async function handleGetLocation(plateId) {
  const data = await MOVE_CAR_STATUS.get(`requester_location:${plateId}`)
  if (data) {
    return new Response(data, { headers: { 'Content-Type': 'application/json' } })
  }
  return new Response(JSON.stringify({ error: 'No location' }), { status: 404 })
}

async function handleOwnerConfirmAction(request, plateId) {
  try {
    const body = await request.json()
    const ownerLocation = body.location || null
    const ownerReply = body.reply || null

    if (ownerLocation) {
      const urls = generateMapUrls(ownerLocation.lat, ownerLocation.lng)
      await MOVE_CAR_STATUS.put(`owner_location:${plateId}`, JSON.stringify({
        lat: ownerLocation.lat,
        lng: ownerLocation.lng,
        ...urls,
        reply: ownerReply,
        timestamp: Date.now()
      }), { expirationTtl: CONFIG.KV_TTL })
    } else if (ownerReply) {
      // 如果没有位置但有回复，也存储回复
      await MOVE_CAR_STATUS.put(`owner_location:${plateId}`, JSON.stringify({
        reply: ownerReply,
        timestamp: Date.now()
      }), { expirationTtl: CONFIG.KV_TTL })
    }

    await MOVE_CAR_STATUS.put(`notify_status:${plateId}`, 'confirmed', { expirationTtl: 600 })
    
    // 关闭请求链路 - 确认后该请求者无法再次发送
    await closeRequest(plateId)
    
    return new Response(JSON.stringify({ success: true, closed: true }), {
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error) {
    await MOVE_CAR_STATUS.put(`notify_status:${plateId}`, 'confirmed', { expirationTtl: 600 })
    await closeRequest(plateId)
    return new Response(JSON.stringify({ success: true, closed: true }), {
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

function renderMainPage(origin, boundPlate, plateId) {
  const phone = typeof PHONE_NUMBER !== 'undefined' ? PHONE_NUMBER : ''

  const html = `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes, viewport-fit=cover">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <meta name="theme-color" content="#ff6b9d">
    <title>通知车主挪车</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" crossorigin>
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;700&display=swap" rel="stylesheet" media="print" onload="this.media='all'">
    <noscript>
      <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;700&display=swap" rel="stylesheet">
    </noscript>
    <style>
      :root {
        --sat: env(safe-area-inset-top, 0px);
        --sar: env(safe-area-inset-right, 0px);
        --sab: env(safe-area-inset-bottom, 0px);
        --sal: env(safe-area-inset-left, 0px);
        --primary: #ff6b9d;
        --secondary: #feca57;
        --accent: #54a0ff;
        --light: #f8f9fa;
        --dark: #2d3436;
        --pink: #ff9ff3;
        --purple: #5f27cd;
      }
      * {
        box-sizing: border-box;
        -webkit-tap-highlight-color: transparent;
        margin: 0;
        padding: 0;
      }
      html {
        font-size: 16px;
        -webkit-text-size-adjust: 100%;
      }
      html, body {
        height: 100%;
      }
      body {
        font-family: 'Noto Sans SC', -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif;
        background: linear-gradient(135deg, #ff6b9d 0%, #feca57 25%, #48dbfb 50%, #1dd1a1 75%, #5f27cd 100%);
        background-size: 400% 400%;
        animation: gradientBG 15s ease infinite;
        min-height: 100vh;
        min-height: -webkit-fill-available;
        padding: clamp(16px, 4vw, 24px);
        padding-top: calc(clamp(16px, 4vw, 24px) + var(--sat));
        padding-bottom: calc(clamp(16px, 4vw, 24px) + var(--sab));
        padding-left: calc(clamp(16px, 4vw, 24px) + var(--sal));
        padding-right: calc(clamp(16px, 4vw, 24px) + var(--sar));
        display: flex;
        justify-content: center;
        align-items: center;
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
        text-rendering: optimizeLegibility;
        position: relative;
        backface-visibility: hidden;
        transform: translateZ(0);
      }
      @keyframes gradientBG {
        0% { background-position: 0% 50%; }
        50% { background-position: 100% 50%; }
        100% { background-position: 0% 50%; }
      }
      .loading-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(255, 255, 255, 0.9);
        display: flex;
        justify-content: center;
        align-items: center;
        z-index: 9999;
        backface-visibility: hidden;
        transform: translateZ(0);
      }
      .loading-content {
        text-align: center;
        padding: 24px;
        background: rgba(255, 255, 255, 0.95);
        border-radius: 16px;
        box-shadow: 0 10px 40px rgba(255, 107, 157, 0.3);
        backface-visibility: hidden;
        transform: translateZ(0);
        border: 2px solid #ffd1dc;
      }
      .loading-spinner {
        width: 48px;
        height: 48px;
        margin: 0 auto 16px;
        border: 4px solid #ffd1dc;
        border-top: 4px solid #ff6b9d;
        border-radius: 50%;
        animation: spin 1s linear infinite;
      }
      @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
      .loading-content p {
        color: #ff6b9d;
        font-weight: 600;
        margin: 0;
      }
      @media (max-height: 600px) {
        body {
          align-items: flex-start;
          padding-top: calc(clamp(12px, 3vw, 20px) + var(--sat));
        }
      }
      body::before {
        content: ''; position: fixed; inset: 0;
        background: url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='0.15'%3E%3Ccircle cx='30' cy='30' r='2'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E");
        z-index: -1;
      }
      body::after {
        content: '✨';
        position: fixed;
        top: 20%;
        left: 10%;
        font-size: 24px;
        animation: float 6s ease-in-out infinite;
        z-index: -1;
      }
      body::before {
        content: '🌸';
        position: fixed;
        bottom: 20%;
        right: 10%;
        font-size: 32px;
        animation: float 8s ease-in-out infinite reverse;
        z-index: -1;
      }

      .container {
        width: 100%;
        max-width: 500px;
        display: flex;
        flex-direction: column;
        gap: clamp(10px, 2.5vw, 16px);
      }

      .card {
        background: rgba(255, 255, 255, 0.95);
        border-radius: clamp(20px, 5vw, 28px);
        padding: clamp(18px, 4vw, 28px);
        box-shadow: 0 10px 40px rgba(255, 107, 157, 0.2);
        transition: transform 0.2s ease, box-shadow 0.2s ease;
        border: 2px solid transparent;
        background-clip: padding-box;
        position: relative;
      }
      .card::before {
        content: '';
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        border-radius: clamp(18px, 4.5vw, 26px);
        padding: 2px;
        background: linear-gradient(135deg, #ff6b9d, #feca57, #48dbfb, #1dd1a1, #5f27cd);
        -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
        -webkit-mask-composite: xor;
        mask-composite: exclude;
        z-index: -1;
      }
      @media (hover: hover) {
        .card:hover { 
          transform: translateY(-2px); 
          box-shadow: 0 12px 48px rgba(255, 107, 157, 0.3);
        }
      }
      .card:active { transform: scale(0.98); }

      .header {
        text-align: center;
        padding: clamp(20px, 5vw, 32px) clamp(16px, 4vw, 28px);
        background: linear-gradient(135deg, #ffffff 0%, #fff0f5 100%);
        border: 2px solid #ffb6c1;
      }
      .icon-wrap {
        width: clamp(72px, 18vw, 100px);
        height: clamp(72px, 18vw, 100px);
        background: linear-gradient(135deg, #ff6b9d 0%, #feca57 100%);
        border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        margin: 0 auto clamp(14px, 3vw, 24px);
        box-shadow: 0 12px 32px rgba(255, 107, 157, 0.35);
        animation: pulse 2s ease-in-out infinite;
      }
      .icon-wrap span { font-size: clamp(36px, 9vw, 52px); }
      .header h1 {
        font-size: clamp(22px, 5.5vw, 30px);
        font-weight: 700;
        color: #ff6b9d;
        margin-bottom: 6px;
        text-shadow: 1px 1px 2px rgba(255, 107, 157, 0.3);
      }
      .header p {
        font-size: clamp(13px, 3.5vw, 16px);
        color: #ff8fab;
        font-weight: 500;
      }

      .plate-verify-card { text-align: center; }
      .plate-verify-card h2 {
        font-size: clamp(18px, 4.5vw, 22px);
        color: #ff6b9d;
        margin-bottom: 8px;
        text-shadow: 1px 1px 2px rgba(255, 107, 157, 0.2);
      }
      .plate-verify-card p {
        font-size: clamp(13px, 3.5vw, 15px);
        color: #ff8fab;
        margin-bottom: 20px;
      }
      .plate-input {
        width: 100%;
        padding: clamp(16px, 4vw, 20px);
        font-size: clamp(18px, 4.5vw, 24px);
        text-align: center;
        border: 2px solid #ffb6c1;
        border-radius: clamp(12px, 3vw, 16px);
        margin-bottom: 16px;
        font-weight: 600;
        letter-spacing: 2px;
        text-transform: uppercase;
        background: #fff5f8;
      }
      .plate-input:focus { 
        outline: none; 
        border-color: #ff6b9d;
        box-shadow: 0 0 0 3px rgba(255, 107, 157, 0.1);
      }
      .plate-input.error { 
        border-color: #ff6b9d; 
        background: #fff0f5;
      }
      .verify-btn {
        width: 100%;
        background: linear-gradient(135deg, #ff6b9d 0%, #feca57 25%, #48dbfb 50%, #1dd1a1 75%, #5f27cd 100%);
        background-size: 400% 400%;
        animation: gradientBG 3s ease infinite;
        color: white;
        border: 2px solid transparent;
        padding: clamp(16px, 4vw, 20px);
        border-radius: clamp(12px, 3vw, 16px);
        font-size: clamp(16px, 4vw, 18px);
        font-weight: 700;
        cursor: pointer;
        transition: all 0.2s;
        -webkit-tap-highlight-color: transparent;
        touch-action: manipulation;
        user-select: none;
        box-shadow: 0 8px 24px rgba(255, 107, 157, 0.3);
        position: relative;
        background-clip: padding-box;
      }
      .verify-btn::before {
        content: '';
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        border-radius: clamp(10px, 2.5vw, 14px);
        padding: 2px;
        background: linear-gradient(135deg, #ff6b9d, #feca57, #48dbfb, #1dd1a1, #5f27cd);
        -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
        -webkit-mask-composite: xor;
        mask-composite: exclude;
        z-index: -1;
      }
      .verify-btn:active { transform: scale(0.96); transition: transform 0.1s ease; }
      .verify-btn:disabled {
        background: linear-gradient(135deg, #ffcdd2 0%, #ffb3ba 100%);
        cursor: not-allowed;
        box-shadow: none;
      }
      .error-msg {
        color: #ff6b9d;
        font-size: clamp(13px, 3.5vw, 14px);
        margin-top: 12px;
        display: none;
      }
      .error-msg.show { display: block; }

      .input-card { padding: 0; overflow: hidden; }
      .input-card textarea {
        width: 100%;
        min-height: clamp(90px, 20vw, 120px);
        border: none;
        padding: clamp(16px, 4vw, 24px);
        font-size: clamp(15px, 4vw, 18px);
        font-family: inherit;
        resize: none;
        outline: none;
        color: #ff6b9d;
        background: #fff5f8;
        line-height: 1.5;
      }
      .input-card textarea::placeholder { color: #ffb6c1; }
      .tags {
        display: flex;
        gap: clamp(6px, 2vw, 10px);
        padding: 0 clamp(12px, 3vw, 20px) clamp(14px, 3vw, 20px);
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
        scrollbar-width: none;
      }
      .tags::-webkit-scrollbar { display: none; }
      .tag {
        background: linear-gradient(135deg, #ffd1dc 0%, #ffb6c1 100%);
        color: #ff6b9d;
        padding: clamp(8px, 2vw, 12px) clamp(12px, 3vw, 18px);
        border-radius: 20px;
        font-size: clamp(13px, 3.5vw, 15px);
        font-weight: 600;
        white-space: nowrap;
        cursor: pointer;
        transition: all 0.2s;
        border: 1px solid #ff9aa2;
        min-height: 44px;
        display: flex;
        align-items: center;
        box-shadow: 0 4px 12px rgba(255, 107, 157, 0.15);
      }
      .tag:active { 
        transform: scale(0.95); 
        background: #ffb6c1;
        box-shadow: 0 2px 8px rgba(255, 107, 157, 0.2);
      }

      .loc-card {
        display: flex;
        align-items: center;
        gap: clamp(10px, 3vw, 16px);
        padding: clamp(14px, 3.5vw, 22px) clamp(16px, 4vw, 24px);
        cursor: pointer;
        min-height: 64px;
        background: #fff5f8;
        border: 2px solid #ffd1dc;
      }
      .loc-icon {
        width: clamp(44px, 11vw, 56px);
        height: clamp(44px, 11vw, 56px);
        border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        font-size: clamp(22px, 5.5vw, 28px);
        transition: all 0.3s;
        flex-shrink: 0;
        box-shadow: 0 4px 12px rgba(255, 107, 157, 0.2);
      }
      .loc-icon.loading { 
        background: linear-gradient(135deg, #feca57 0%, #ff6b9d 100%); 
        animation: pulse 1.5s ease-in-out infinite;
      }
      .loc-icon.success { 
        background: linear-gradient(135deg, #54a0ff 0%, #ff6b9d 100%); 
      }
      .loc-icon.error { 
        background: linear-gradient(135deg, #ff6b9d 0%, #feca57 100%); 
      }
      .loc-content { flex: 1; min-width: 0; }
      .loc-title {
        font-size: clamp(15px, 4vw, 18px);
        font-weight: 600;
        color: #ff6b9d;
      }
      .loc-status {
        font-size: clamp(12px, 3.2vw, 14px);
        color: #ff8fab;
        margin-top: 3px;
      }
      .loc-status.success { 
        color: #54a0ff;
        font-weight: 500;
      }
      .loc-status.error { 
        color: #ff6b9d;
        font-weight: 500;
      }

      .btn-main {
        background: linear-gradient(135deg, #ff6b9d 0%, #feca57 100%);
        color: white;
        border: none;
        padding: clamp(16px, 4vw, 22px);
        border-radius: clamp(16px, 4vw, 22px);
        font-size: clamp(16px, 4.2vw, 20px);
        font-weight: 700;
        cursor: pointer;
        display: flex; align-items: center; justify-content: center; gap: 10px;
        box-shadow: 0 10px 30px rgba(255, 107, 157, 0.35);
        transition: all 0.2s;
        min-height: 56px;
        -webkit-tap-highlight-color: transparent;
        touch-action: manipulation;
        user-select: none;
        border: 2px solid #ffd1dc;
      }
      .btn-main:active { transform: scale(0.96); transition: transform 0.1s ease; }
      .btn-main:disabled {
        background: linear-gradient(135deg, #ffcdd2 0%, #ffb3ba 100%);
        box-shadow: none;
        cursor: not-allowed;
      }

      .toast {
        position: fixed;
        top: calc(20px + var(--sat));
        left: 50%;
        transform: translateX(-50%) translateY(-100px);
        background: linear-gradient(135deg, #ffd1dc 0%, #ffb6c1 100%);
        padding: clamp(12px, 3vw, 16px) clamp(20px, 5vw, 32px);
        border-radius: 20px;
        font-size: clamp(14px, 3.5vw, 16px);
        font-weight: 600;
        color: #ff6b9d;
        box-shadow: 0 10px 40px rgba(255, 107, 157, 0.2);
        opacity: 0;
        transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        z-index: 100;
        max-width: calc(100vw - 40px);
        border: 2px solid #ff9aa2;
      }
      .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }

      .waiting-card {
        text-align: center;
        background: linear-gradient(135deg, #fff9c4 0%, #ffecb3 100%);
        border: 2px solid #ffd54f;
        border-radius: clamp(20px, 5vw, 28px);
      }
      .waiting-icon {
        font-size: clamp(48px, 12vw, 64px);
        margin-bottom: 12px;
        display: block;
        animation: pulse 1.5s ease-in-out infinite;
      }
      .waiting-card h3 {
        color: #ff6b9d;
        margin-bottom: 8px;
        font-size: clamp(18px, 4.5vw, 22px);
        text-shadow: 1px 1px 2px rgba(255, 107, 157, 0.2);
      }
      .waiting-card p {
        color: #ff8fab;
        font-size: clamp(14px, 3.5vw, 16px);
      }
      .countdown {
        font-size: clamp(24px, 6vw, 32px);
        font-weight: 700;
        color: #ff6b9d;
        margin-top: 12px;
        text-shadow: 1px 1px 2px rgba(255, 107, 157, 0.2);
      }

      .owner-card {
        background: linear-gradient(135deg, #e3f2fd 0%, #bbdefb 100%);
        border: 2px solid #90caf9;
        text-align: center;
        border-radius: clamp(20px, 5vw, 28px);
      }
      .owner-card.hidden { display: none; }
      .owner-card h3 {
        color: #54a0ff;
        margin-bottom: 8px;
        font-size: clamp(18px, 4.5vw, 22px);
        text-shadow: 1px 1px 2px rgba(84, 160, 255, 0.2);
      }
      .owner-card p {
        color: #64b5f6;
        margin-bottom: 16px;
        font-size: clamp(14px, 3.5vw, 16px);
      }
      .owner-card .map-links {
        display: flex;
        gap: clamp(8px, 2vw, 14px);
        flex-wrap: wrap;
      }
      .owner-card .map-btn {
        flex: 1;
        min-width: 120px;
        padding: clamp(12px, 3vw, 16px);
        border-radius: clamp(12px, 3vw, 16px);
        text-decoration: none;
        font-weight: 600;
        font-size: clamp(13px, 3.5vw, 15px);
        text-align: center;
        min-height: 48px;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 4px 12px rgba(84, 160, 255, 0.2);
        transition: all 0.2s;
      }
      .map-btn.amap { 
        background: linear-gradient(135deg, #1890ff 0%, #69c0ff 100%); 
        color: white;
      }
      .map-btn.apple { 
        background: linear-gradient(135deg, #3a3a3c 0%, #86868b 100%); 
        color: white;
      }
      .map-btn:active { transform: scale(0.96); }

      .action-card {
        display: flex;
        flex-direction: column;
        gap: clamp(10px, 2.5vw, 14px);
        background: #fff5f8;
        border: 2px solid #ffd1dc;
      }
      .action-hint {
        text-align: center;
        font-size: clamp(13px, 3.5vw, 15px);
        color: #ff8fab;
        margin-bottom: 4px;
      }
      .btn-retry, .btn-phone {
        color: white;
        border: none;
        padding: clamp(14px, 3.5vw, 18px);
        border-radius: clamp(14px, 3.5vw, 18px);
        font-size: clamp(15px, 4vw, 17px);
        font-weight: 700;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        transition: all 0.2s;
        min-height: 52px;
        text-decoration: none;
        -webkit-tap-highlight-color: transparent;
        touch-action: manipulation;
        user-select: none;
        box-shadow: 0 6px 20px rgba(255, 107, 157, 0.2);
      }
      .btn-retry {
        background: linear-gradient(135deg, #feca57 0%, #ff9ff3 100%);
      }
      .btn-retry:active { transform: scale(0.96); transition: transform 0.1s ease; }
      .btn-retry:disabled {
        background: linear-gradient(135deg, #ffecb3 0%, #ffd54f 100%);
        box-shadow: none;
        cursor: not-allowed;
      }
      .btn-phone {
        background: linear-gradient(135deg, #ff6b9d 0%, #feca57 100%);
      }
      .btn-phone:active { transform: scale(0.96); transition: transform 0.1s ease; }

      .closed-card {
        text-align: center;
        background: linear-gradient(135deg, #e8f5e8 0%, #c8e6c9 100%);
        border: 2px solid #81c784;
        border-radius: clamp(20px, 5vw, 28px);
      }
      .closed-icon {
        font-size: clamp(56px, 14vw, 80px);
        margin-bottom: 12px;
        display: block;
        animation: pulse 2s ease-in-out infinite;
      }
      .closed-card h2 {
        color: #4caf50;
        margin-bottom: 8px;
        font-size: clamp(20px, 5vw, 26px);
        text-shadow: 1px 1px 2px rgba(76, 175, 80, 0.2);
      }
      .closed-card p {
        color: #66bb6a;
        font-size: clamp(14px, 3.5vw, 16px);
      }

      @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.8; } }
      @keyframes float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }

      @media (min-width: 768px) {
        body { align-items: center; }
        .container { max-width: 480px; }
      }
      @media (min-width: 1024px) {
        .container { max-width: 520px; }
        .card { padding: 32px; }
      }
      @media (max-width: 350px) {
        .container { gap: 10px; }
        .card { padding: 14px; border-radius: 18px; }
        .tags { gap: 6px; }
        .tag { padding: 8px 10px; font-size: 12px; }
      }
    </style>
  </head>
  <body>
    <div id="toast" class="toast"></div>
    <div id="loadingOverlay" class="loading-overlay" style="display: none;">
      <div class="loading-content">
        <div class="loading-spinner"></div>
        <p>处理中...</p>
      </div>
    </div>

    <!-- 车牌验证页面 -->
    <div class="container" id="verifyView">
      <div class="card header">
        <div class="icon-wrap"><span>🚗</span></div>
        <h1>挪车通知</h1>
        <p id="greetingText">请稍候，正在处理您的请求</p>
      </div>
      <script>
        // 安抚通知人的话语
        const greetings = [
          "车主大大正在赶来的路上～",
          "别急别急，车主马上就到啦！",
          "感谢你呀，耐心等待一下下",
          "车主看到消息会立刻来的",
          "我们正在努力联系车主哦",
          "稍等片刻，车主马上就出现",
          "谢谢你的理解和配合～",
          "车主正在火速赶来，马上就到",
          "请稍候，车主很快就会来处理"
        ];
        
        // 随机选择一条显示
        document.addEventListener('DOMContentLoaded', function() {
          const greetingElement = document.getElementById('greetingText');
          if (greetingElement) {
            const randomGreeting = greetings[Math.floor(Math.random() * greetings.length)];
            greetingElement.textContent = randomGreeting;
          }
        });
      </script>

      <div class="card plate-verify-card">
        <h2>🔐 我要验牌</h2>
        <p>请输入该车二维码绑定的车牌号<br>验证通过后才能通知车主</p>
        <input type="text" id="plateInput" class="plate-input" placeholder="如: 京A12345" maxlength="10">
        <button class="verify-btn" onclick="verifyPlate()">验证并继续</button>
        <div id="verifyError" class="error-msg">车牌号不匹配，请确认后重试</div>
      </div>
    </div>

    <!-- 主页面 -->
    <div class="container" id="mainView" style="display:none">
      <div class="card header">
        <div class="icon-wrap"><span>🚗</span></div>
        <h1>呼叫车主挪车</h1>
        <p>车牌: ${boundPlate}</p>
      </div>

      <div class="card input-card">
        <textarea id="msgInput" placeholder="输入留言给车主...（可选）"></textarea>
        <div class="tags">
          <div class="tag" onclick="addTag('您的车挡住我了')">🚧 挡路</div>
          <div class="tag" onclick="addTag('临时停靠一下')">⏱️ 临停</div>
          <div class="tag" onclick="addTag('电话打不通')">📞 没接</div>
          <div class="tag" onclick="addTag('麻烦尽快')">🙏 加急</div>
        </div>
      </div>

      <div class="card loc-card">
        <div id="locIcon" class="loc-icon loading">📍</div>
        <div class="loc-content">
          <div class="loc-title">我的位置</div>
          <div id="locStatus" class="loc-status">等待获取...</div>
        </div>
      </div>

      <button id="notifyBtn" class="card btn-main" onclick="sendNotify()">
        <span>🔔</span>
        <span>通知车主</span>
      </button>
    </div>

    <!-- 等待中页面 -->
    <div class="container" id="waitingView" style="display:none">
      <div class="card waiting-card">
        <span class="waiting-icon">⏳</span>
        <h3>通知已发送</h3>
        <p>正在等待车主回应...</p>
        <div class="countdown" id="countdown">60</div>
        <p style="font-size: 12px; margin-top: 8px;">下次可发送倒计时</p>
      </div>

      <div id="ownerFeedback" class="card owner-card hidden">
        <span style="font-size:56px; display:block; margin-bottom:16px">🎉</span>
        <h3>车主已确认</h3>
        <div id="ownerReply" class="owner-reply" style="display:none; margin-bottom:16px; padding:12px; background:#fff0f5; border-radius:12px;"></div>
        <p>正在赶来，点击查看车主位置</p>
        <div id="ownerMapLinks" class="map-links" style="display:none">
          <a id="ownerAmapLink" href="#" class="map-btn amap">🗺️ 高德地图</a>
          <a id="ownerAppleLink" href="#" class="map-btn apple">🍎 Apple Maps</a>
        </div>
      </div>

      <div class="card action-card">
        <p class="action-hint">车主没反应？</p>
        <button id="retryBtn" class="btn-retry" onclick="retryNotify()" disabled>
          <span>🔔</span>
          <span>再次通知 (<span id="retryCountdown">60</span>s)</span>
        </button>
        <a href="tel:${phone}" class="btn-phone">
          <span>📞</span>
          <span>直接打电话</span>
        </a>
      </div>
    </div>

    <!-- 请求已关闭页面 -->
    <div class="container" id="closedView" style="display:none">
      <div class="card closed-card">
        <span class="closed-icon">✅</span>
        <h2>请求已处理完毕</h2>
        <p>车主已确认并分享位置<br>该次挪车请求已完成</p>
      </div>
      
      <div id="ownerReplyCard" class="card" style="text-align: left; display: none;">
        <h3 style="margin-bottom: 12px; color: #ff6b9d;">车主回复</h3>
        <div id="ownerReplyContent" class="owner-reply" style="padding: 16px; background: #fff0f5; border-radius: 12px; margin-bottom: 16px;"></div>
      </div>
      
      <div id="ownerLocationCard" class="card" style="text-align: center; display: none;">
        <h3 style="margin-bottom: 12px; color: #ff6b9d;">车主位置</h3>
        <p style="color: #718096; font-size: 14px; margin-bottom: 16px;">点击查看车主实时位置</p>
        <div id="ownerMapLinksClosed" class="map-links" style="display: flex; gap: 12px; justify-content: center;">
          <a id="ownerAmapLinkClosed" href="#" class="map-btn amap" style="padding: 12px 16px; background: #f8f9fa; border-radius: 8px; text-decoration: none; color: #333; font-size: 14px;">🗺️ 高德地图</a>
          <a id="ownerAppleLinkClosed" href="#" class="map-btn apple" style="padding: 12px 16px; background: #f8f9fa; border-radius: 8px; text-decoration: none; color: #333; font-size: 14px;">🍎 Apple Maps</a>
        </div>
      </div>
      
      <div class="card" style="text-align: center;">
        <p style="color: #718096; font-size: 14px;">车主已确认，正在赶来</p>
      </div>
    </div>

    <script>
      let userLocation = null
      let checkTimer = null
      let countdownTimer = null
      let boundPlate = '${boundPlate}'
      let plateId = '${plateId}'
      let isVerified = false
      let canRetry = false

      window.onload = () => {
        requestLocation()
      }

      async function verifyPlate() {
        const input = document.getElementById('plateInput')
        const error = document.getElementById('verifyError')
        const plate = input.value.trim()
        
        if (!plate) {
          input.classList.add('error')
          error.textContent = '请输入车牌号'
          error.classList.add('show')
          return
        }
        
        try {
          const res = await fetch('/api/verify-plate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ plate: plate })
          })
          
          const data = await res.json()
          
          if (data.success) {
            isVerified = true
            document.getElementById('verifyView').style.display = 'none'
            document.getElementById('mainView').style.display = 'flex'
            showToast('✅ 验证通过')
          } else {
            input.classList.add('error')
            error.textContent = data.message || '车牌号不匹配'
            error.classList.add('show')
          }
        } catch (e) {
          input.classList.add('error')
          error.textContent = '验证失败，请重试'
          error.classList.add('show')
        }
      }
      
      const plateInput = document.getElementById('plateInput')
      const verifyError = document.getElementById('verifyError')
      
      if (plateInput && verifyError) {
        plateInput.addEventListener('input', function() {
          this.classList.remove('error')
          verifyError.classList.remove('show')
        })
        
        plateInput.addEventListener('keypress', function(e) {
          if (e.key === 'Enter') verifyPlate()
        })
      }

      function requestLocation() {
        const icon = document.getElementById('locIcon')
        const txt = document.getElementById('locStatus')

        icon.className = 'loc-icon loading'
        txt.className = 'loc-status'
        txt.innerText = '正在获取定位...'

        if ('geolocation' in navigator) {
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude }
              icon.className = 'loc-icon success'
              txt.className = 'loc-status success'
              txt.innerText = '已获取位置 ✓'
            },
            (err) => {
              icon.className = 'loc-icon error'
              txt.className = 'loc-status error'
              txt.innerText = '位置获取失败，将延迟发送'
            },
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
          )
        } else {
          icon.className = 'loc-icon error'
          txt.className = 'loc-status error'
          txt.innerText = '浏览器不支持定位'
        }
      }

      function addTag(text) {
        document.getElementById('msgInput').value = text
      }

      // 缓存DOM元素引用
      const domElements = {
        notifyBtn: document.getElementById('notifyBtn'),
        msgInput: document.getElementById('msgInput'),
        loadingOverlay: document.getElementById('loadingOverlay'),
        mainView: document.getElementById('mainView'),
        waitingView: document.getElementById('waitingView'),
        closedView: document.getElementById('closedView')
      }

      async function sendNotify() {
        const btn = domElements.notifyBtn
        const msg = domElements.msgInput.value
        const delayed = !userLocation
        const loadingOverlay = domElements.loadingOverlay

        btn.disabled = true
        btn.innerHTML = '<span>🚀</span><span>发送中...</span>'
        loadingOverlay.style.display = 'flex'

        try {
          const res = await fetch('/api/notify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              message: msg, 
              location: userLocation, 
              delayed: delayed,
              boundPlate: boundPlate
            })
          })

          const data = await res.json()

          if (res.ok && data.success) {
            if (delayed) {
              showToast('⏳ 通知将延迟30秒发送')
            } else {
              showToast('✅ 发送成功！')
            }
            domElements.mainView.style.display = 'none'
            domElements.waitingView.style.display = 'flex'
            startCountdown()
            startPolling()
          } else if (data.closed) {
            showToast('该请求已处理完毕')
            domElements.mainView.style.display = 'none'
            domElements.closedView.style.display = 'flex'
          } else {
            throw new Error(data.error || '发送失败')
          }
        } catch (e) {
          showToast('❌ ' + (e.message || '发送失败，请重试'))
          btn.disabled = false
          btn.innerHTML = '<span>🔔</span><span>通知车主</span>'
        } finally {
          loadingOverlay.style.display = 'none'
        }
      }

      function startCountdown() {
        let seconds = 60
        const countdownEl = document.getElementById('countdown')
        const retryCountdownEl = document.getElementById('retryCountdown')
        const retryBtn = document.getElementById('retryBtn')
        const phoneBtn = document.querySelector('.btn-phone')
        
        // 禁用拨打电话按钮
        if (phoneBtn) {
          phoneBtn.style.pointerEvents = 'none'
          phoneBtn.style.opacity = '0.5'
          phoneBtn.style.cursor = 'not-allowed'
        }
        
        countdownTimer = setInterval(() => {
          seconds--
          countdownEl.textContent = seconds
          retryCountdownEl.textContent = seconds
          
          if (seconds <= 0) {
            clearInterval(countdownTimer)
            canRetry = true
            retryBtn.disabled = false
            retryBtn.innerHTML = '<span>🔔</span><span>再次通知</span>'
            
            // 启用拨打电话按钮
            if (phoneBtn) {
              phoneBtn.style.pointerEvents = 'auto'
              phoneBtn.style.opacity = '1'
              phoneBtn.style.cursor = 'pointer'
            }
          }
        }, 1000)
      }

      function startPolling() {
        let count = 0
        let interval = 5000 // 初始5秒轮询
        
        checkTimer = setInterval(async () => {
          count++
          if (count > 30) { clearInterval(checkTimer); return }
          try {
            const res = await fetch('/api/check-status')
            const data = await res.json()
            
            if (data.status === 'confirmed') {
              const fb = document.getElementById('ownerFeedback')
              fb.classList.remove('hidden')

              // 显示车主回复
              if (data.ownerLocation && data.ownerLocation.reply) {
                const replyEl = document.getElementById('ownerReply')
                replyEl.textContent = data.ownerLocation.reply
                replyEl.style.display = 'block'
              }

              if (data.ownerLocation && data.ownerLocation.amapUrl) {
                document.getElementById('ownerMapLinks').style.display = 'flex'
                document.getElementById('ownerAmapLink').href = data.ownerLocation.amapUrl
                document.getElementById('ownerAppleLink').href = data.ownerLocation.appleUrl
              }

              // 隐藏拨打电话按钮
              const actionCard = document.querySelector('.action-card')
              if (actionCard) {
                actionCard.style.display = 'none'
              }

              // 只有当请求未关闭时才继续轮询
              if (!data.closed) {
                clearInterval(checkTimer)
                clearInterval(countdownTimer)
                if(navigator.vibrate) navigator.vibrate([200, 100, 200])
              }
            }
            
            if (data.closed) {
              // 清除定时器
              clearInterval(checkTimer)
              clearInterval(countdownTimer)
              
              // 显示车主回复（如果有）
              const ownerReplyCard = document.getElementById('ownerReplyCard')
              const ownerReplyContent = document.getElementById('ownerReplyContent')
              if (data.ownerLocation && data.ownerLocation.reply) {
                ownerReplyContent.textContent = data.ownerLocation.reply
                ownerReplyCard.style.display = 'block'
              }
              
              // 显示车主位置链接（如果有）
              const ownerLocationCard = document.getElementById('ownerLocationCard')
              if (data.ownerLocation && data.ownerLocation.amapUrl) {
                document.getElementById('ownerAmapLinkClosed').href = data.ownerLocation.amapUrl
                document.getElementById('ownerAppleLinkClosed').href = data.ownerLocation.appleUrl
                ownerLocationCard.style.display = 'block'
              }
              
              // 直接跳转到关闭页面，避免多跳转
              document.getElementById('waitingView').style.display = 'none'
              document.getElementById('closedView').style.display = 'flex'
            }
            
            // 逐渐增加轮询间隔，减少网络请求
            if (count > 5) interval = 8000
            if (count > 10) interval = 12000
            clearInterval(checkTimer)
            checkTimer = setInterval(arguments.callee, interval)
          } catch(e) {}
        }, interval)
      }

      function showToast(text) {
        const t = document.getElementById('toast')
        t.innerText = text
        t.classList.add('show')
        setTimeout(() => t.classList.remove('show'), 3000)
      }

      async function retryNotify() {
        if (!canRetry) return
        
        const btn = document.getElementById('retryBtn')
        btn.disabled = true
        btn.innerHTML = '<span>🚀</span><span>发送中...</span>'

        try {
          const res = await fetch('/api/notify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              message: '再次通知：请尽快挪车', 
              location: userLocation,
              boundPlate: boundPlate
            })
          })

          const data = await res.json()
          
          if (res.ok && data.success) {
            showToast('✅ 再次通知已发送！')
            canRetry = false
            startCountdown()
          } else if (data.closed) {
            showToast('该请求已处理完毕')
            document.getElementById('waitingView').style.display = 'none'
            document.getElementById('closedView').style.display = 'flex'
          } else {
            throw new Error(data.error || '发送失败')
          }
        } catch (e) {
          showToast('❌ ' + (e.message || '发送失败'))
          btn.disabled = false
          btn.innerHTML = '<span>🔔</span><span>再次通知</span>'
        }
      }
    </script>
  </body>
  </html>
  `
  return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } })
}

function renderOwnerPage(boundPlate) {
  const html = `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes, viewport-fit=cover">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <meta name="theme-color" content="#ff6b9d">
    <title>确认挪车</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" crossorigin>
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;700&display=swap" rel="stylesheet" media="print" onload="this.media='all'">
    <noscript>
      <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;700&display=swap" rel="stylesheet">
    </noscript>
    <style>
      :root {
        --sat: env(safe-area-inset-top, 0px);
        --sar: env(safe-area-inset-right, 0px);
        --sab: env(safe-area-inset-bottom, 0px);
        --sal: env(safe-area-inset-left, 0px);
        --primary: #ff6b9d;
        --secondary: #feca57;
        --accent: #54a0ff;
        --light: #f8f9fa;
        --dark: #2d3436;
        --pink: #ff9ff3;
        --purple: #5f27cd;
      }
      * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
      html {
        font-size: 16px;
        -webkit-text-size-adjust: 100%;
      }
      body {
        font-family: 'Noto Sans SC', -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif;
        background: linear-gradient(135deg, #ff6b9d 0%, #feca57 25%, #48dbfb 50%, #1dd1a1 75%, #5f27cd 100%);
        background-size: 400% 400%;
        animation: gradientBG 15s ease infinite;
        min-height: 100vh;
        min-height: -webkit-fill-available;
        padding: clamp(16px, 4vw, 24px);
        padding-top: calc(clamp(16px, 4vw, 24px) + var(--sat));
        padding-bottom: calc(clamp(16px, 4vw, 24px) + var(--sab));
        padding-left: calc(clamp(16px, 4vw, 24px) + var(--sal));
        padding-right: calc(clamp(16px, 4vw, 24px) + var(--sar));
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        position: relative;
      }
      @keyframes gradientBG {
        0% { background-position: 0% 50%; }
        50% { background-position: 100% 50%; }
        100% { background-position: 0% 50%; }
      }
      .loading-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(255, 255, 255, 0.9);
        display: flex;
        justify-content: center;
        align-items: center;
        z-index: 9999;
      }
      .loading-content {
        text-align: center;
        padding: 24px;
        background: rgba(255, 255, 255, 0.95);
        border-radius: 16px;
        box-shadow: 0 10px 40px rgba(255, 107, 157, 0.3);
        border: 2px solid #ffd1dc;
      }
      .loading-spinner {
        width: 48px;
        height: 48px;
        margin: 0 auto 16px;
        border: 4px solid #ffd1dc;
        border-top: 4px solid #ff6b9d;
        border-radius: 50%;
        animation: spin 1s linear infinite;
      }
      @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
      .loading-content p {
        color: #ff6b9d;
        font-weight: 600;
        margin: 0;
      }
      @media (max-height: 600px) {
        body {
          justify-content: flex-start;
          padding-top: calc(clamp(12px, 3vw, 20px) + var(--sat));
        }
      }
      body::before {
        content: '✨';
        position: fixed;
        top: 20%;
        left: 10%;
        font-size: 24px;
        animation: float 6s ease-in-out infinite;
        z-index: -1;
      }
      body::after {
        content: '🌸';
        position: fixed;
        bottom: 20%;
        right: 10%;
        font-size: 32px;
        animation: float 8s ease-in-out infinite reverse;
        z-index: -1;
      }
      .card {
        background: rgba(255,255,255,0.95);
        padding: clamp(24px, 6vw, 36px);
        border-radius: clamp(24px, 6vw, 32px);
        text-align: center;
        width: 100%;
        max-width: 420px;
        box-shadow: 0 20px 60px rgba(255, 107, 157, 0.3);
        border: 2px solid #ffd1dc;
        position: relative;
        overflow: hidden;
      }
      .card::before {
        content: '';
        position: absolute;
        top: -50%;
        right: -50%;
        width: 200%;
        height: 200%;
        background: radial-gradient(circle, rgba(255,107,157,0.1) 0%, rgba(255,107,157,0) 70%);
        z-index: 0;
      }
      .emoji {
        font-size: clamp(52px, 13vw, 72px);
        margin-bottom: clamp(16px, 4vw, 24px);
        display: block;
        animation: pulse 2s ease-in-out infinite;
        position: relative;
        z-index: 1;
      }
      h1 {
        font-size: clamp(22px, 5.5vw, 28px);
        color: #ff6b9d;
        margin-bottom: 8px;
        text-shadow: 1px 1px 2px rgba(255, 107, 157, 0.2);
        position: relative;
        z-index: 1;
      }
      .subtitle {
        color: #ff8fab;
        font-size: clamp(14px, 3.5vw, 16px);
        margin-bottom: clamp(20px, 5vw, 28px);
        position: relative;
        z-index: 1;
      }
      .plate-info {
        background: linear-gradient(135deg, #ffd1dc 0%, #ffb6c1 100%);
        border-radius: clamp(12px, 3vw, 16px);
        padding: clamp(12px, 3vw, 16px);
        margin-bottom: clamp(16px, 4vw, 24px);
        font-size: clamp(16px, 4vw, 20px);
        font-weight: 700;
        color: #ff6b9d;
        border: 2px solid #ff9aa2;
        position: relative;
        z-index: 1;
        box-shadow: 0 4px 12px rgba(255, 107, 157, 0.15);
      }

      .map-section {
        background: linear-gradient(135deg, #e3f2fd 0%, #bbdefb 100%);
        border-radius: clamp(14px, 3.5vw, 18px);
        padding: clamp(14px, 3.5vw, 20px);
        margin-bottom: clamp(16px, 4vw, 24px);
        display: none;
        border: 2px solid #90caf9;
        position: relative;
        z-index: 1;
      }
      .map-section.show { display: block; }
      .map-section p {
        font-size: clamp(12px, 3.2vw, 14px);
        color: #54a0ff;
        margin-bottom: 12px;
        font-weight: 600;
      }
      .map-links {
        display: flex;
        gap: clamp(8px, 2vw, 12px);
        flex-wrap: wrap;
      }
      .map-btn {
        flex: 1;
        min-width: 110px;
        padding: clamp(12px, 3vw, 16px);
        border-radius: clamp(10px, 2.5vw, 14px);
        text-decoration: none;
        font-weight: 600;
        font-size: clamp(13px, 3.5vw, 15px);
        text-align: center;
        transition: transform 0.2s, box-shadow 0.2s;
        min-height: 48px;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 4px 12px rgba(84, 160, 255, 0.2);
      }
      .map-btn:active { transform: scale(0.96); }
      .map-btn.amap { 
        background: linear-gradient(135deg, #1890ff 0%, #69c0ff 100%); 
        color: white;
      }
      .map-btn.apple { 
        background: linear-gradient(135deg, #3a3a3c 0%, #86868b 100%); 
        color: white;
      }

      .loc-status {
        background: linear-gradient(135deg, #fff9c4 0%, #ffecb3 100%);
        border-radius: clamp(10px, 2.5vw, 14px);
        padding: clamp(10px, 2.5vw, 14px) clamp(14px, 3.5vw, 18px);
        margin-bottom: clamp(16px, 4vw, 24px);
        font-size: clamp(13px, 3.5vw, 15px);
        color: #ff6b9d;
        display: none;
        border: 2px solid #ffd54f;
        position: relative;
        z-index: 1;
      }
      .loc-status.show { display: block; }
      .loc-status.success { 
        background: linear-gradient(135deg, #e8f5e8 0%, #c8e6c9 100%); 
        color: #4caf50;
        border: 2px solid #81c784;
      }
      .loc-status.error { 
        background: linear-gradient(135deg, #ffebee 0%, #ffcdd2 100%); 
        color: #ff6b9d;
        border: 2px solid #ff8a80;
      }

      .reply-section {
        margin-bottom: clamp(16px, 4vw, 24px);
        position: relative;
        z-index: 1;
      }
      .reply-section textarea {
        width: 100%;
        min-height: 80px;
        padding: clamp(12px, 3vw, 16px);
        border: 2px solid #ffb6c1;
        border-radius: clamp(12px, 3vw, 16px);
        font-size: clamp(14px, 3.5vw, 16px);
        font-family: inherit;
        resize: none;
        outline: none;
        background: #fff5f8;
        color: #ff6b9d;
      }
      .reply-section textarea:focus {
        border-color: #ff6b9d;
        box-shadow: 0 0 0 3px rgba(255, 107, 157, 0.1);
      }
      .reply-section textarea::placeholder {
        color: #ffb6c1;
      }

      .quick-replies {
        display: flex;
        flex-wrap: wrap;
        gap: clamp(6px, 2vw, 10px);
        margin-top: clamp(10px, 2.5vw, 14px);
      }
      .quick-reply {
        background: linear-gradient(135deg, #ffd1dc 0%, #ffb6c1 100%);
        color: #ff6b9d;
        padding: clamp(8px, 2vw, 12px) clamp(12px, 3vw, 16px);
        border-radius: 20px;
        font-size: clamp(13px, 3.5vw, 14px);
        font-weight: 600;
        cursor: pointer;
        border: 1px solid #ff9aa2;
        min-height: 40px;
        display: flex;
        align-items: center;
        transition: all 0.2s;
        box-shadow: 0 4px 12px rgba(255, 107, 157, 0.15);
      }
      .quick-reply:active {
        transform: scale(0.96);
        background: linear-gradient(135deg, #ffb6c1 0%, #ff9aa2 100%);
        box-shadow: 0 2px 8px rgba(255, 107, 157, 0.2);
      }

      .btn {
        background: linear-gradient(135deg, #ff6b9d 0%, #feca57 100%);
        color: white;
        border: none;
        width: 100%;
        padding: clamp(16px, 4vw, 20px);
        border-radius: clamp(14px, 3.5vw, 18px);
        font-size: clamp(16px, 4.2vw, 19px);
        font-weight: 700;
        cursor: pointer;
        box-shadow: 0 8px 24px rgba(255, 107, 157, 0.35);
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        transition: all 0.2s;
        min-height: 56px;
        -webkit-tap-highlight-color: transparent;
        touch-action: manipulation;
        user-select: none;
        border: 2px solid #ffd1dc;
        position: relative;
        z-index: 1;
      }
      .btn:active { transform: scale(0.96); transition: transform 0.1s ease; }
      .btn:disabled {
        background: linear-gradient(135deg, #ffcdd2 0%, #ffb3ba 100%);
        box-shadow: none;
        cursor: not-allowed;
      }

      .done-msg {
        background: linear-gradient(135deg, #e8f5e8 0%, #c8e6c9 100%);
        border-radius: clamp(14px, 3.5vw, 18px);
        padding: clamp(16px, 4vw, 24px);
        margin-top: clamp(16px, 4vw, 24px);
        display: none;
        border: 2px solid #81c784;
        position: relative;
        z-index: 1;
      }
      .done-msg.show { display: block; }
      .done-msg p {
        color: #4caf50;
        font-weight: 600;
        font-size: clamp(15px, 4vw, 17px);
      }
      .done-msg .sub {
        color: #66bb6a;
        font-size: clamp(13px, 3.5vw, 14px);
        margin-top: 8px;
        font-weight: 500;
      }
      @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.8; } }
      @keyframes float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }

      @media (min-width: 768px) {
        .card {
          max-width: 440px;
          padding: 40px;
        }
      }
      @media (orientation: landscape) and (max-height: 500px) {
        body {
          justify-content: flex-start;
          padding-top: calc(12px + var(--sat));
        }
        .card {
          padding: 20px 28px;
        }
        .emoji {
          font-size: 44px;
          margin-bottom: 12px;
        }
        .subtitle {
          margin-bottom: 16px;
        }
      }
      @media (max-width: 350px) {
        .card {
          padding: 20px;
          border-radius: 20px;
        }
        .map-btn {
          min-width: 100px;
          padding: 10px;
        }
      }
    </style>
  </head>
  <body>
    <div class="card">
      <span class="emoji">👋</span>
      <h1>收到挪车请求</h1>
      <p class="subtitle">对方正在等待，请尽快确认</p>
      
      <div class="plate-info">🚙 ${boundPlate}</div>

      <div id="mapArea" class="map-section">
        <p>📍 对方位置（可判断是否真在车旁）</p>
        <div class="map-links">
          <a id="amapLink" href="#" class="map-btn amap">🗺️ 高德地图</a>
          <a id="appleLink" href="#" class="map-btn apple">🍎 Apple Maps</a>
        </div>
      </div>

      <div class="reply-section">
        <textarea id="ownerReply" placeholder="回复对方（可选）" maxlength="100"></textarea>
        <div class="quick-replies">
          <div class="quick-reply" onclick="useQuickReply('马上来')">🚀 马上来</div>
          <div class="quick-reply" onclick="useQuickReply('稍等5分钟')">⏱️ 稍等5分钟</div>
          <div class="quick-reply" onclick="useQuickReply('正在下楼')">🏃 正在下楼</div>
          <div class="quick-reply" onclick="useQuickReply('抱歉，马上挪')">🙏 抱歉，马上挪</div>
        </div>
      </div>

      <button id="confirmBtn" class="btn" onclick="confirmMove()">
        <span>🚀</span>
        <span>我已知晓，正在前往</span>
      </button>

      <div id="doneMsg" class="done-msg">
        <p>✅ 已通知对方您正在赶来！</p>
        <p class="sub">该请求已关闭，对方无法再次发送通知</p>
      </div>
    </div>

    <script>
      let ownerLocation = null

      function useQuickReply(text) {
        document.getElementById('ownerReply').value = text
      }

      window.onload = async () => {
        try {
          const res = await fetch('/api/get-location')
          if(res.ok) {
            const data = await res.json()
            if(data.amapUrl) {
              document.getElementById('mapArea').classList.add('show')
              document.getElementById('amapLink').href = data.amapUrl
              document.getElementById('appleLink').href = data.appleUrl
            }
          }
        } catch(e) {}
      }

      async function confirmMove() {
        const btn = document.getElementById('confirmBtn')
        btn.disabled = true
        btn.innerHTML = '<span>📍</span><span>获取位置中...</span>'

        if ('geolocation' in navigator) {
          navigator.geolocation.getCurrentPosition(
            async (pos) => {
              ownerLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude }
              await doConfirm()
            },
            async (err) => {
              ownerLocation = null
              await doConfirm()
            },
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
          )
        } else {
          ownerLocation = null
          await doConfirm()
        }
      }

      async function doConfirm() {
        const btn = document.getElementById('confirmBtn')
        const reply = document.getElementById('ownerReply').value.trim()
        btn.innerHTML = '<span>⏳</span><span>确认中...</span>'

        try {
          await fetch('/api/owner-confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              location: ownerLocation,
              reply: reply
            })
          })

          btn.innerHTML = '<span>✅</span><span>已确认</span>'
          btn.style.background = 'linear-gradient(135deg, #9ca3af 0%, #6b7280 100%)'
          document.getElementById('doneMsg').classList.add('show')
        } catch(e) {
          btn.disabled = false
          btn.innerHTML = '<span>🚀</span><span>我已知晓，正在前往</span>'
        }
      }
    </script>
  </body>
  </html>
  `
  return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } })
}
