import { Context, Schema, h } from 'koishi'
import axios from 'axios'
import { load } from 'cheerio'
import * as iconv from 'iconv-lite'
import * as fs from 'fs'
import * as path from 'path'

export const name = 'wenku8-search'

export const inject = ['database']

declare module 'koishi' {
  interface Tables {
    wenku8_blacklist: Wenku8Blacklist
  }
}

export interface Wenku8Blacklist {
  userId: string
}

export interface Config {
  username: string
  password: string
  commandName: string
  defaultSort: 'lastupdate' | 'allvisit' | 'fullflag' | 'anime'
  downloadPath: string
  timeout: number
  useForward: boolean
  maxCache: number
  oneToOne: boolean
  adminQQ: string
}

export const Config: Schema<Config> = Schema.object({
  username: Schema.string().required().description('轻小说文库账号'),
  password: Schema.string().required().description('轻小说文库密码'),
  commandName: Schema.string().default('wenku8').description('搜索指令名称'),
  defaultSort: Schema.union([
    Schema.const('lastupdate').description('按更新查看'),
    Schema.const('allvisit').description('按热门查看'),
    Schema.const('fullflag').description('只看完结'),
    Schema.const('anime').description('只看动画化'),
  ]).default('lastupdate').description('默认排序方式'),
  downloadPath: Schema.string().default('./wenku8-downloads').description('下载文件保存路径'),
  timeout: Schema.number().default(60).description('搜索状态超时时间（秒）'),
  useForward: Schema.boolean().default(false).description('是否使用合并转发消息展示搜索结果'),
  maxCache: Schema.number().default(5).description('缓存文件数量上限'),
  oneToOne: Schema.boolean().default(true).description('一对一模式：仅搜索发起者可操作。关闭后任何人都能操作你的搜索结果'),
  adminQQ: Schema.string().default('').description('管理员QQ号，只有管理员可以使用黑名单管理指令'),
})

interface BookInfo {
  id: string
  title: string
  author: string
  category: string
  tags: string
  status: string
  available: boolean
  detailUrl: string
}

export async function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('wenku8')
  let cookieJar = ''
  let isLoggedIn = false

  // 初始化黑名单表
  ctx.model.extend('wenku8_blacklist', {
    userId: 'string',
  }, { primary: 'userId' })

  // 从数据库加载黑名单
  const blacklistSet = new Set<string>()
  try {
    const dbBlacklist = await ctx.database.get('wenku8_blacklist', {})
    dbBlacklist.forEach(row => blacklistSet.add(row.userId))
  } catch (e) {
    logger.warn('加载黑名单失败:', e)
  }

  function gbkEncode(str: string): string {
    const buf = iconv.encode(str, 'gbk')
    let result = ''
    for (let i = 0; i < buf.length; i++) {
      result += '%' + buf[i].toString(16).toUpperCase().padStart(2, '0')
    }
    return result
  }

  async function request(url: string, method: 'get' | 'post' = 'get', data?: string): Promise<string> {
    const options: any = {
      method, url,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Cookie': cookieJar,
      },
      responseType: 'arraybuffer',
      timeout: 15000,
      maxRedirects: 5,
    }
    if (data) {
      options.data = data
      options.headers['Content-Type'] = 'application/x-www-form-urlencoded'
      options.headers['Origin'] = 'https://www.wenku8.net'
      options.headers['Referer'] = 'https://www.wenku8.net/login.php'
    }
    const res = await axios(options)
    const setCookie = res.headers['set-cookie']
    if (setCookie && Array.isArray(setCookie)) {
      const cookieMap = new Map<string, string>()
      if (cookieJar) {
        cookieJar.split('; ').forEach((c: string) => {
          const idx = c.indexOf('=')
          if (idx > 0) cookieMap.set(c.slice(0, idx).trim(), c.slice(idx + 1).trim())
        })
      }
      setCookie.forEach((c: string) => {
        const mainPart = c.split(';')[0]
        const idx = mainPart.indexOf('=')
        if (idx > 0) cookieMap.set(mainPart.slice(0, idx).trim(), mainPart.slice(idx + 1).trim())
      })
      cookieJar = Array.from(cookieMap.entries()).map(([k, v]) => `${k}=${v}`).join('; ')
    }
    return iconv.decode(res.data, 'gbk')
  }

  async function login(): Promise<boolean> {
    try {
      const formData = new URLSearchParams()
      formData.append('username', config.username)
      formData.append('password', config.password)
      formData.append('usecookie', '315360000')
      formData.append('action', 'login')
      formData.append('submit', '\u767b\u5f55')
      const html = await request(
        'https://www.wenku8.net/login.php?do=submit&jumpurl=http%3A%2F%2Fwww.wenku8.net%2Findex.php',
        'post', formData.toString()
      )
      isLoggedIn = html.includes('欢迎您') || html.includes('退出登录')
      return isLoggedIn
    } catch (e) {
      logger.warn('登录失败:', e)
      return false
    }
  }

  async function ensureLogin(): Promise<boolean> {
    if (isLoggedIn) return true
    return await login()
  }

  function isDetailPage(html: string): boolean {
    return html.includes('小说作者：') && html.includes('packshow.php?id=')
  }

  function isListPage(html: string): boolean {
    return html.includes('width:373px;height:136px;float:left')
  }

  function parseListPage(html: string): { books: BookInfo[]; currentPage: number; totalPage: number } {
    const $ = load(html)
    const books: BookInfo[] = []
    let currentPage = 1, totalPage = 1
    const pageStats = $('#pagestats').text()
    if (pageStats) {
      const match = pageStats.match(/(\d+)\/(\d+)/)
      if (match) { currentPage = parseInt(match[1]); totalPage = parseInt(match[2]) }
    }
    $('div[style*="width:373px;height:136px;float:left"]').each((_idx: number, el: any) => {
      const $el = $(el)
      const $link = $el.find('div > a[href^="/book/"]').first()
      const href = $link.attr('href') || ''
      const idMatch = href.match(/\/book\/(\d+)\.htm/)
      const id = idMatch ? idMatch[1] : ''
      const title = $link.attr('title') || ''
      let author = '', category = '', tags = '', status = ''
      const $infoDiv = $el.find('div').last()
      const $ps = $infoDiv.find('p')
      $ps.each((idx2: number, p: any) => {
        const text = $(p).text().trim()
        if (idx2 === 0 && text.includes('作者:') && text.includes('分类:')) {
          const match = text.match(/作者:(.+?)\/分类:(.+)/)
          if (match) { author = match[1].trim(); category = match[2].trim() }
        }
        if (text.includes('Tags:')) tags = $(p).find('span').text().trim()
        if (idx2 === 1) {
          if (text.includes('已完结')) status = '已完结'
          else if (text.includes('连载中')) status = '连载中'
        }
      })
      const hotText = $infoDiv.find('p.hottext').text().trim()
      const available = !hotText.includes('下架')
      if (id && title) {
        books.push({ id, title, author, category, tags, status, available, detailUrl: `https://www.wenku8.net${href}` })
      }
    })
    return { books, currentPage, totalPage }
  }

  function parseDetailPage(html: string): BookInfo {
    const $ = load(html)
    let title = ''
    const titleMatch = $('title').text().match(/^(.+?)\s+-\s+/)
    if (titleMatch) title = titleMatch[1].trim()
    let id = '', author = '', category = '', status = '', tags = ''
    const packHref = $('a[href*="packshow.php?id="]').attr('href')
    if (packHref) {
      const idMatch = packHref.match(/id=(\d+)/)
      if (idMatch) id = idMatch[1]
    }
    $('td').each((_idx: number, el: any) => {
      const text = $(el).text().trim()
      if (text.startsWith('小说作者：')) author = text.replace('小说作者：', '').trim()
      if (text.startsWith('文库分类：')) category = text.replace('文库分类：', '').trim()
      if (text.startsWith('文章状态：')) status = text.replace('文章状态：', '').trim()
    })
    $('span.hottext').each((_idx: number, el: any) => {
      const text = $(el).text()
      if (text.includes('作品Tags：')) tags = text.replace('作品Tags：', '').trim()
    })
    return { id, title, author, category, tags, status, available: true, detailUrl: `https://www.wenku8.net/book/${id}.htm` }
  }

  async function fetchBooks(searchType: 'title' | 'tag' | 'list', keyword: string, sort: string, page: number) {
    let url = ''
    if (searchType === 'title') {
      url = `https://www.wenku8.net/modules/article/search.php?searchtype=articlename&searchkey=${gbkEncode(keyword)}&page=${page}`
    } else if (searchType === 'tag') {
      url = `https://www.wenku8.net/modules/article/tags.php?t=${gbkEncode(keyword)}&page=${page}`
    } else if (searchType === 'list') {
      url = sort === 'fullflag'
        ? `https://www.wenku8.net/modules/article/articlelist.php?fullflag=1&page=${page}`
        : `https://www.wenku8.net/modules/article/toplist.php?sort=${sort}&page=${page}`
    }
    try {
      const html = await request(url)
      let books: BookInfo[] = [], currentPage = page, totalPage = 1
      if (isDetailPage(html)) {
        const book = parseDetailPage(html)
        if (book.id) books = [book]
      } else if (isListPage(html)) {
        const r = parseListPage(html)
        books = r.books; currentPage = r.currentPage; totalPage = r.totalPage
      } else {
        return '搜索结果不存在。'
      }
      if (books.length === 0) return '搜索结果不存在。'
      return { books, currentPage, totalPage }
    } catch (e) {
      logger.warn('搜索请求失败:', e)
      return '搜索失败，请稍后重试。'
    }
  }

  function buildBookText(book: BookInfo, index: number): string {
    const flag = book.available ? '' : ' [无法下载]'
    return `[${index + 1}] 《${book.title}》${flag}\n作者：${book.author || '未知'} | 分类：${book.category || '未知'}\nTags：${book.tags || '无'} | 状态：${book.status || '未知'}`
  }

  function formatResultText(books: BookInfo[], currentPage: number, totalPage: number, searchType: string, sort: string): string {
    let msg = `第 ${currentPage}/${totalPage} 页\n`
    if (searchType === 'list') {
      const sortNames: Record<string, string> = { lastupdate: '按更新查看', allvisit: '按热门查看', fullflag: '只看完结', anime: '只看动画化' }
      msg += `排序：${sortNames[sort] || sort}\n`
    }
    msg += '━━━━━━━━━━━━━━\n'
    books.forEach((book, i) => { msg += buildBookText(book, i) + (i < books.length - 1 ? '\n\n' : '\n') })
    msg += '━━━━━━━━━━━━━━\n'
    msg += '回复「下载+序号」下载对应书籍\n'
    if (currentPage < totalPage) msg += '回复「下一页」查看下一页\n'
    if (currentPage > 1) msg += '回复「上一页」查看上一页\n'
    msg += `回复「页数X」跳转至第X页（1~${totalPage}）
`
    msg += '回复「取消」退出搜索'
    return msg
  }

  async function sendResults(session: any, books: BookInfo[], currentPage: number, totalPage: number, searchType: string, sort: string) {
    if (!config.useForward) {
      await session.send(formatResultText(books, currentPage, totalPage, searchType, sort))
      return
    }
    const texts: string[] = []
    let header = `第 ${currentPage}/${totalPage} 页`
    if (searchType === 'list') {
      const sortNames: Record<string, string> = { lastupdate: '按更新查看', allvisit: '按热门查看', fullflag: '只看完结', anime: '只看动画化' }
      header += `\n排序：${sortNames[sort] || sort}`
    }
    texts.push(header)
    books.forEach((book, i) => texts.push(buildBookText(book, i)))
    let tip = '回复「下载+序号」下载对应书籍\n'
    if (currentPage < totalPage) tip += '回复「下一页」查看下一页\n'
    if (currentPage > 1) tip += '回复「上一页」查看上一页\n'
    tip += `回复「页数X」跳转至第X页（1~${totalPage}）
`
    tip += '回复「取消」退出搜索'
    texts.push(tip)

    try {
      await sendForward(session, texts)
    } catch (e) {
      logger.warn('合并转发发送失败，回退到普通文本:', e)
      await session.send(formatResultText(books, currentPage, totalPage, searchType, sort))
    }
  }

  // ==================== 合并转发（修复版）====================

  async function sendForward(session: any, texts: string[]) {
    const selfId = Number(session.bot?.selfId || session.userId || 100000)
    const nickname = session.bot?.username || String(selfId)

    // NapCat 要求的 node 格式：user_id 必须是数字，content 是标准消息段数组
    const nodes = texts.map(text => ({
      type: 'node',
      data: {
        user_id: selfId,
        nickname,
        content: [{ type: 'text', data: { text } }]
      }
    }))

    const internal = session.bot?.internal
    if (!internal) throw new Error('无法访问 OneBot 内部接口')

    try {
      if (session.guildId) {
        // 群聊：优先用 send_group_forward_msg
        if (internal.sendGroupForwardMsg) {
          await internal.sendGroupForwardMsg(Number(session.guildId), nodes)
        } else if (internal._get) {
          await internal._get('send_group_forward_msg', {
            group_id: Number(session.guildId),
            messages: nodes
          })
        } else {
          throw new Error('未找到群合并转发接口')
        }
      } else {
        // 私聊：优先用 send_private_forward_msg
        if (internal.sendPrivateForwardMsg) {
          await internal.sendPrivateForwardMsg(Number(session.userId), nodes)
        } else if (internal._get) {
          await internal._get('send_private_forward_msg', {
            user_id: Number(session.userId),
            messages: nodes
          })
        } else {
          throw new Error('未找到私聊合并转发接口')
        }
      }
    } catch (e) {
      logger.warn('合并转发失败:', e)
      throw e
    }
  }

  // ==================== 缓存管理 ====================

  async function cleanupCache(dir: string, maxCache: number) {
    try {
      const files = fs.readdirSync(dir)
        .map(f => {
          const fullPath = path.join(dir, f)
          const stat = fs.statSync(fullPath)
          return { name: f, path: fullPath, mtime: stat.mtimeMs }
        })
        .filter(f => f.name.endsWith('.txt'))
        .sort((a, b) => a.mtime - b.mtime) // 最旧的在前

      if (files.length > maxCache) {
        const toDelete = files.slice(0, files.length - maxCache)
        for (const f of toDelete) {
          try {
            fs.unlinkSync(f.path)
            logger.info(`缓存清理：删除旧文件 ${f.name}`)
          } catch (e) {
            logger.warn(`缓存清理失败：${f.name}`, e)
          }
        }
      }
    } catch (e) {
      logger.warn('缓存扫描失败:', e)
    }
  }

  // ==================== 下载（修复版）====================

    async function doDownload(session: any, book: BookInfo): Promise<string> {
    if (!book.available) {
      return '无书源：该书因版权问题已下架，无法下载。\n您可以继续选择其他书籍下载或取消等待。'
    }
    try {
      let bookId = book.id
      if (!bookId && book.detailUrl) {
        const match = book.detailUrl.match(/\/book\/(\d+)\.htm/)
        if (match) bookId = match[1]
      }
      if (!bookId) {
        return '下载失败：无法获取书籍ID。\n您可以继续选择其他书籍下载或取消等待。'
      }

      const packUrl = `https://www.wenku8.net/modules/article/packshow.php?id=${bookId}&type=txtfull`
      const html = await request(packUrl)
      const $ = load(html)
      const downloadLink = $('a[href*="down.php?type=utf8&node=1"]').attr('href')
      if (!downloadLink) {
        return '下载失败：未找到下载链接。\n您可以继续选择其他书籍下载或取消等待。'
      }

      const dir = path.resolve(config.downloadPath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      const safeTitle = book.title.replace(/[\\/:*?"<>|]/g, '_')
      const fileName = `${safeTitle}_${bookId}.txt`
      const filePath = path.join(dir, fileName)

      const res = await axios({
        method: 'get', url: downloadLink,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': cookieJar, 'Referer': packUrl },
        responseType: 'stream', timeout: 120000,
      })
      const writer = fs.createWriteStream(filePath)
      res.data.pipe(writer)
      await new Promise<void>((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject) })

      const internal = session.bot?.internal
      if (!internal) throw new Error('无法访问 OneBot 内部接口')

      if (session.guildId) {
        await internal.uploadGroupFile(Number(session.guildId), filePath, fileName)
      } else {
        await internal.uploadPrivateFile(Number(session.userId), filePath, fileName)
      }

      await cleanupCache(dir, config.maxCache)
      return `《${book.title}》下载完成！`
    } catch (e) {
      logger.warn('下载失败:', e)
      return '下载失败，请稍后重试。\n您可以继续选择其他书籍下载或取消等待。'
    }
  }

  // ==================== 交互循环 ====================

    async function interact(session: any, searchType: 'title' | 'tag' | 'list', keyword: string, sort: string, page: number) {
    let currentPage = page
    let totalPage = 1
    let books: BookInfo[] = []

    // 首次搜索
    const first = await fetchBooks(searchType, keyword, sort, currentPage)
    if (typeof first === 'string') {
      await session.send(first)
      return
    }
    books = first.books
    currentPage = first.currentPage
    totalPage = first.totalPage
    await sendResults(session, books, currentPage, totalPage, searchType, sort)

    // prompt 交互循环
        // prompt 交互循环
    while (true) {
      let input: string | undefined

      if (config.oneToOne) {
        // 一对一模式：只监听发起者
        input = await session.prompt(config.timeout * 1000)
      } else {
        // 非一对一：全频道监听（会拦截该频道所有消息直到匹配或超时）
        input = await session.prompt(config.timeout * 1000)
      }

      if (input === undefined) {
        await session.send('搜索已超时，任务已自动取消。')
        return
      }
      const trimmed = input.trim()

      if (trimmed === '取消' || trimmed === 'cancel') {
        await session.send('已取消搜索。')
        return
      }

      if (trimmed === '下一页' || trimmed === 'n') {
        if (currentPage >= totalPage) {
          await session.send('已经是最后一页了。')
          continue
        }
        const result = await fetchBooks(searchType, keyword, sort, currentPage + 1)
        if (typeof result === 'string') { await session.send(result); return }
        books = result.books; currentPage = result.currentPage; totalPage = result.totalPage
        await sendResults(session, books, currentPage, totalPage, searchType, sort)
        continue
      }

      if (trimmed === '上一页' || trimmed === 'p') {
        if (currentPage <= 1) {
          await session.send('已经是第一页了。')
          continue
        }
        const result = await fetchBooks(searchType, keyword, sort, currentPage - 1)
        if (typeof result === 'string') { await session.send(result); return }
        books = result.books; currentPage = result.currentPage; totalPage = result.totalPage
        await sendResults(session, books, currentPage, totalPage, searchType, sort)
        continue
      }

      // 页数指定跳转：支持 "页数2"、"第2页"、"page 2"、"p 2"、"2"
      const pageJumpMatch = trimmed.match(/^(?:页数\s*|第\s*|page\s*|p\s*)?(\d+)(?:\s*页)?$/i)
      if (pageJumpMatch) {
        const targetPage = parseInt(pageJumpMatch[1])
        if (targetPage === currentPage) {
          await session.send(`当前已在第 ${targetPage} 页。`)
          continue
        }
        if (targetPage < 1 || targetPage > totalPage) {
          await session.send(`页码超出范围，请输入 1~${totalPage} 之间的页码。`)
          continue
        }
        const result = await fetchBooks(searchType, keyword, sort, targetPage)
        if (typeof result === 'string') { await session.send(result); return }
        books = result.books; currentPage = result.currentPage; totalPage = result.totalPage
        await sendResults(session, books, currentPage, totalPage, searchType, sort)
        continue
      }

      const dlMatch = trimmed.match(/^(?:下载|dl)\s*(\d+)$/)
      if (dlMatch) {
        const idx = parseInt(dlMatch[1]) - 1
        if (idx < 0 || idx >= books.length) {
          await session.send('序号超出范围，请重新输入。')
          continue
        }
        const msg = await doDownload(session, books[idx])
        await session.send(msg)
        if (msg.includes('下载完成')) return
        continue
      }

      await session.send('无效指令，请回复「下载+序号」「下一页」「上一页」或「取消」。')
    }
  }
  
  // ==================== 指令注册 ====================

  const cmd = ctx.command(`${config.commandName} [...rest]`, '轻小说文库搜索与下载')
    .usage(`输入关键词搜索小说，支持以下用法：
${config.commandName} <关键词> — 按标题搜索
${config.commandName} tag <标签> — 按标签搜索
${config.commandName} list — 按默认排序浏览`)
    .example(`${config.commandName} 魔法`)
    .example(`${config.commandName} tag 校园`)
    .example(`${config.commandName} list`)

  cmd.action(async ({ session }, ...rest) => {
    if (!session) return '会话异常，请重试。'

    // 黑名单检查
    if (blacklistSet.has(String(session.userId))) {
      return '你已被列入黑名单，无法使用此插件。'
    }

    const rawInput = rest.join(' ').trim()

    if (!rawInput) {
      return `请输入搜索内容。用法：
${config.commandName} <关键词> [更新|热门|完结|动画化] — 按标题搜索
${config.commandName} tag <标签> [更新|热门|完结|动画化] — 按标签搜索
${config.commandName} list [更新|热门|完结|动画化] — 按默认排序浏览`
    }

    if (!(await ensureLogin())) {
      return '登录失败，请检查账号密码。'
    }

    // 排序关键词映射
    const sortMap: Record<string, string> = {
      '更新': 'lastupdate',
      '热门': 'allvisit',
      '完结': 'fullflag',
      '动画化': 'anime',
    }

    // 解析输入，提取可能的排序后缀
    function parseInput(input: string): { keyword: string; sort: string } {
      const parts = input.split(/\s+/)
      const last = parts[parts.length - 1]
      if (sortMap[last]) {
        return { keyword: parts.slice(0, -1).join(' '), sort: sortMap[last] }
      }
      return { keyword: input, sort: config.defaultSort }
    }

    if (rawInput.startsWith('tag ')) {
      const afterTag = rawInput.slice(4).trim()
      const { keyword, sort } = parseInput(afterTag)
      if (!keyword) return '请输入标签名。'
      await interact(session, 'tag', keyword, sort, 1)
      return
    }

    if (rawInput === 'list' || rawInput.startsWith('list ')) {
      const afterList = rawInput === 'list' ? '' : rawInput.slice(5).trim()
      const { keyword: _, sort } = parseInput(afterList || 'list')
      await interact(session, 'list', '', sort, 1)
      return
    }

    const { keyword, sort } = parseInput(rawInput)
    await interact(session, 'title', keyword, sort, 1)
  })


  // ==================== 管理员指令：黑名单管理 ====================

  const blacklistCmd = ctx.command(`${config.commandName}.blacklist <action:string> <qq:string>`, '黑名单管理（管理员）')
    .usage(`用法：
${config.commandName}.blacklist add <QQ号> — 将用户加入黑名单
${config.commandName}.blacklist remove <QQ号> — 将用户移出黑名单`)
    .example(`${config.commandName}.blacklist add 123456789`)
    .example(`${config.commandName}.blacklist remove 123456789`)

  blacklistCmd.action(async ({ session }, action, qq) => {
    if (!session) return '会话异常，请重试。'
    if (!config.adminQQ || String(session.userId) !== String(config.adminQQ)) {
      return '你没有权限执行此操作。'
    }
    if (!action || !qq) {
      return `用法：${config.commandName}.blacklist add <QQ号> 或 ${config.commandName}.blacklist remove <QQ号>`
    }
    const qqStr = String(qq).trim()
    if (!/^\d+$/.test(qqStr)) {
      return '请输入有效的QQ号。'
    }

    if (action === 'add') {
      if (blacklistSet.has(qqStr)) {
        return `用户 ${qqStr} 已在黑名单中。`
      }
      try {
        await ctx.database.create('wenku8_blacklist', { userId: qqStr })
        blacklistSet.add(qqStr)
        logger.info(`管理员 ${session.userId} 将用户 ${qqStr} 加入黑名单`)
        return `已将用户 ${qqStr} 加入黑名单（已持久化）。`
      } catch (e) {
        logger.warn('数据库写入黑名单失败:', e)
        return '操作失败，请检查数据库状态。'
      }
    }

    if (action === 'remove') {
      if (!blacklistSet.has(qqStr)) {
        return `用户 ${qqStr} 不在黑名单中。`
      }
      try {
        await ctx.database.remove('wenku8_blacklist', { userId: qqStr })
        blacklistSet.delete(qqStr)
        logger.info(`管理员 ${session.userId} 将用户 ${qqStr} 移出黑名单`)
        return `已将用户 ${qqStr} 移出黑名单（已持久化）。`
      } catch (e) {
        logger.warn('数据库移除黑名单失败:', e)
        return '操作失败，请检查数据库状态。'
      }
    }

    return `未知操作「${action}」。可用操作：add、remove`
  })

  // ==================== 管理员指令：黑名单列表 ====================

  const blacklistListCmd = ctx.command(`${config.commandName}.blacklist.list`, '查看黑名单列表（管理员）')
    .usage(`用法：${config.commandName}.blacklist.list`)
    .example(`${config.commandName}.blacklist.list`)

  blacklistListCmd.action(async ({ session }) => {
    if (!session) return '会话异常，请重试。'
    if (!config.adminQQ || String(session.userId) !== String(config.adminQQ)) {
      return '你没有权限执行此操作。'
    }
    if (blacklistSet.size === 0) {
      return '当前黑名单为空。'
    }
    const list = Array.from(blacklistSet).join('\n')
    return `当前黑名单用户（共 ${blacklistSet.size} 人）：\n${list}`
  })
}

