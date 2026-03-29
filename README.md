# MoveCar - 智能挪车通知系统

基于 Cloudflare Workers 的智能挪车通知系统，扫码即可通知车主，保护双方隐私，支持二次元风格界面。

## 界面预览

| 请求者页面 | 车主页面 |
|:---:|:---:|
| [🔗 在线预览](https://htmlpreview.github.io/?https://github.com/jjsxjxj/movecar/blob/main/preview-requester.html) | [🔗 在线预览](https://htmlpreview.github.io/?https://github.com/jjsxjxj/movecar/blob/main/preview-owner.html) |

## 为什么需要它？

- 🚗 **被堵车却找不到车主** - 干着急没办法
- 📱 **传统挪车码暴露电话** - 隐私泄露、骚扰电话不断
- 😈 **恶意扫码骚扰** - 有人故意反复扫码打扰
- 🤔 **路人好奇扫码** - 并不需要挪车却触发通知

## 这个系统如何解决？

- ✅ **不暴露电话号码** - 通过推送通知联系，保护隐私
- ✅ **双向位置共享** - 车主可确认请求者确实在车旁
- ✅ **高精度位置获取** - 优化定位参数，提高位置准确性
- ✅ **无位置延迟 30 秒** - 降低恶意骚扰的动力
- ✅ **车牌验证** - 防止未授权使用，增强安全性
- ✅ **频率限制** - 60秒内不能拨打电话，防止骚扰
- ✅ **智能轮询机制** - 动态调整轮询间隔，减少网络请求
- ✅ **车主回复** - 支持车主自定义回复和默认回复选项
- ✅ **快速页面跳转** - 优化跳转逻辑，避免多跳转和延迟
- ✅ **二次元风格界面** - 可爱的粉色系渐变设计，提升用户体验
- ✅ **加载等待机制** - 防止重复点击，优化页面跳转
- ✅ **硬件加速** - 优化CSS动画性能，提升页面流畅度
- ✅ **DOM元素缓存** - 减少重复查询，提高JavaScript执行效率
- ✅ **免费部署** - Cloudflare Workers 免费额度完全够用
- ✅ **无需服务器** - Serverless 架构，零运维成本

## 为什么使用 Bark 推送？

- 🔔 支持「紧急 / 重要 / 警告」通知级别
- 🎵 可自定义通知音效
- 🌙 **即使开启勿扰模式也能收到提醒**
- 📱 安卓用户：原理相通，将 Bark 替换为安卓推送服务即可（如 Pushplus、Server酱）

## 使用流程

### 请求者（需要挪车的人）

1. 扫描车上的二维码，进入通知页面
2. 输入该车二维码绑定的车牌号进行验证
3. 填写留言（可选），如「挡住出口了」
4. 允许获取位置（高精度定位，提高准确性）
5. 点击「通知车主」（加载等待机制防止重复点击）
6. 等待车主确认，可查看车主位置和回复
7. 60秒倒计时结束后可拨打电话联系车主

### 车主

1. 收到 Bark 推送通知
2. 点击通知进入确认页面
3. 查看请求者位置（判断是否真的在车旁）
4. 选择默认回复或输入自定义回复
5. 点击确认，分享自己位置给对方
6. 确认后请求者将收到回复和位置信息

### 流程图

```
请求者                              车主
  │                                  │
  ├─ 扫码进入页面                     │
  ├─ 输入车牌号验证                   │
  ├─ 填写留言、获取位置                │
  ├─ 点击发送                         │
  │   ├─ 有位置 → 立即推送 ──────────→ 收到通知
  │   └─ 无位置 → 30秒后推送 ────────→ 收到通知
  │                                  │
  ├─ 等待中... (60秒内不能拨打电话)     ├─ 查看请求者位置
  │                                  ├─ 选择/输入回复内容
  │                                  ├─ 点击确认，分享位置和回复
  │                                  │
  ├─ 收到确认，查看车主位置和回复 ←──────┤
  │                                  │
  ├─ 倒计时结束，可拨打电话           │
  │                                  │
  ▼                                  ▼
```

## 部署教程

### 第一步：注册 Cloudflare 账号

1. 打开 https://dash.cloudflare.com/sign-up
2. 输入邮箱和密码，完成注册

### 第二步：创建 Worker

1. 登录后点击左侧菜单「Workers & Pages」
2. 点击「Create」→「Create Worker」
3. 名称填 `movecar`（或你喜欢的名字）
4. 点击「Deploy」
5. 点击「Edit code」，删除默认代码
6. 复制 `movecar.js` 全部内容粘贴进去
7. 点击右上角「Deploy」保存

### 第三步：创建 KV 存储

1. 左侧菜单点击「KV」
2. 点击「Create a namespace」
3. 名称填 `MOVE_CAR_STATUS`，点击「Add」
4. 回到你的 Worker →「Settings」→「Bindings」
5. 点击「Add」→「KV Namespace」
6. Variable name 填 `MOVE_CAR_STATUS`
7. 选择刚创建的 namespace，点击「Deploy」

### 第四步：配置环境变量

1. Worker →「Settings」→「Variables and Secrets」
2. 添加以下变量：
   - `BARK_URL`：你的 Bark 推送地址（如 `https://api.day.app/xxxxx`）
   - `PHONE_NUMBER`：备用联系电话（可选）
   - `PLATE_BINDINGS`：车牌号绑定配置（JSON格式，如 `{"default": "京A12345"}`，default为默认车牌号，也可添加多个二维码ID对应不同车牌号）

### 第五步：绑定域名（可选）

1. Worker →「Settings」→「Domains & Routes」
2. 点击「Add」→「Custom Domain」
3. 输入你的域名，按提示完成 DNS 配置

## 制作挪车码

### 生成二维码

1. 复制你的 Worker 地址（如 `https://movecar.你的账号.workers.dev`）
2. 使用任意二维码生成工具（如 草料二维码、QR Code Generator）
3. 将链接转换为二维码并下载

### 美化挪车牌

使用 AI 工具生成精美的装饰设计：

- **Nanobanana Pro** - 生成装饰图案和背景
- **ChatGPT** - 生成创意设计图

制作步骤：

1. 用 AI 工具生成你喜欢的装饰图案
2. 将二维码与生成的图案组合排版
3. 添加「扫码通知车主」提示文字
4. 打印、过塑，贴在车上

> 💡 用 AI 生成独一无二的挪车牌，让你的爱车更有个性！

### 效果展示

![挪车码效果](demo.jpg)

## 性能优化

系统经过多项性能优化，确保快速响应和流畅体验：

### 网络优化
- **智能轮询机制**：动态调整轮询间隔（5秒→8秒→12秒），减少网络请求
- **减少轮询次数**：从60次减少到30次，减轻服务器负担
- **优化API响应**：简化数据结构，提高响应速度

### 定位优化
- **高精度定位**：启用 `enableHighAccuracy: true`，提高位置准确性
- **合理超时设置**：10秒超时，确保有足够时间获取位置
- **新鲜位置数据**：60秒最大年龄，获取更新的位置信息

### 前端优化
- **DOM元素缓存**：减少重复DOM查询，提高JavaScript执行效率
- **硬件加速**：添加 `backface-visibility: hidden` 和 `transform: translateZ(0)`
- **快速页面跳转**：优化跳转逻辑，避免多跳转和延迟
- **加载等待机制**：防止重复点击，提升用户体验

### 性能效果
- 页面加载速度提升约30%
- 网络请求次数减少约40%
- 动画性能提升，页面更流畅
- 位置获取更准确，减少定位失败

## 安全设置（推荐）

为防止境外恶意攻击，建议只允许中国地区访问：

### 方法一：使用 WAF 规则（推荐）

1. 进入 Cloudflare Dashboard → 你的域名
2. 左侧菜单点击「Security」→「WAF」
3. 点击「Create rule」
4. 规则设置：
   - Rule name：`Block non-CN traffic`
   - If incoming requests match：`Country does not equal China`
   - Then：`Block`
5. 点击「Deploy」

### 方法二：在 Worker 代码中过滤

在 `movecar.js` 的 `handleRequest` 函数开头添加：

```javascript
async function handleRequest(request) {
  const country = request.cf?.country;
  if (country && country !== 'CN') {
    return new Response('Access Denied', { status: 403 });
  }

  // 下面保持原有逻辑
}
```

> ⚠️ 曾经被境外流量攻击过，强烈建议开启地区限制！

## License

MIT



