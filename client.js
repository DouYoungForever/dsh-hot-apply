window.__ModuleLoader__.load({
  id: 'dsh-hot-apply',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const text = {
      zh: {
        restart: '重启 DSH',
        restarting: '正在重启…',
        failed: '重启失败',
        unsupported: '找不到 DSH 可执行文件，无法自动重启。',
        reasons: {
          'platform-unsupported': '自动重启目前只支持 Windows 桌面版。',
          'not-desktop-host': '当前 Host 不是桌面应用，无法自动重启。',
          'executable-missing': '找不到 DSH 可执行文件，无法自动重启。',
          'parent-missing': '找不到 DSH 主进程，无法自动重启。',
        },
        reload: '重新加载插件',
        reloading: '正在重新加载…',
        reloadDone: '插件模块已重新加载',
        tab: '一键重启',
        tabTitle: '一键重启 DSH',
        tabIntro: '插件或 DSH 自身更新后，点一下即可关闭并重新打开，使新代码生效。会话记录保存在磁盘上，重启后会回来。',
        statusReady: '当前无需重启',
        statusNeeded: '有改动等待重启生效',
        statusRunning: '有任务正在运行，重启会中断它们',
        confirm: '确认重启',
      },
      en: {
        restart: 'Restart DSH',
        restarting: 'Restarting…',
        failed: 'Restart failed',
        unsupported: 'DSH executable not found; cannot restart automatically.',
        reasons: {
          'platform-unsupported': 'Automatic restart is only available on Windows.',
          'not-desktop-host': 'This host is not the desktop app; it cannot be restarted here.',
          'executable-missing': 'DSH executable not found; cannot restart automatically.',
          'parent-missing': 'DSH main process not found; cannot restart automatically.',
        },
        reload: 'Reload plugins',
        reloading: 'Reloading…',
        reloadDone: 'Plugin modules reloaded',
        tab: 'Restart',
        tabTitle: 'One-click restart',
        tabIntro: 'After an update, restart DSH in one click so the new code takes effect. Sessions live on disk and come back afterwards.',
        statusReady: 'Nothing to restart',
        statusNeeded: 'Changes are waiting for a restart',
        statusRunning: 'Tasks are running; a restart stops them',
        confirm: 'Restart now',
      },
    }

    function lang() {
      const value = typeof navigator !== 'undefined' ? navigator.language : 'zh'
      return /^zh/i.test(value || '') ? text.zh : text.en
    }

    async function postJson(url, body) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      let data = null
      try {
        data = await res.json()
      } catch {
        data = null
      }
      return { ok: res.ok, status: res.status, data }
    }

    async function getJson(url) {
      const res = await fetch(url, { headers: { accept: 'application/json' } })
      let data = null
      try {
        data = await res.json()
      } catch {
        data = null
      }
      return { ok: res.ok, status: res.status, data }
    }

    function useStatus(active) {
      const [snapshot, setSnapshot] = useState(null)
      useEffect(() => {
        if (!active) return undefined
        let alive = true
        const read = () => {
          getJson('/hot-apply/status')
            .then((result) => {
              if (alive && result.ok && result.data) setSnapshot(result.data)
            })
            .catch(() => {})
        }
        read()
        const timer = setInterval(read, 4000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [active])
      return snapshot
    }

    function useRestart() {
      const [phase, setPhase] = useState('idle')
      const [message, setMessage] = useState('')
      const dict = lang()
      const restart = useCallback(() => {
        if (phase === 'sending' || phase === 'sent') return
        setPhase('sending')
        setMessage(dict.restarting)
        postJson('/hot-apply/restart', { mode: 'hard' })
          .then((result) => {
            if (result.ok && result.data && result.data.ok !== false) {
              setPhase('sent')
              setMessage(dict.restarting)
              setTimeout(() => {
                try {
                  window.close()
                } catch {
                  /* the helper closes the window */
                }
              }, 800)
              return
            }
            const detail =
              (result.data && (result.data.error || result.data.message)) ||
              (result.status === 404 ? 'hot-apply endpoint missing' : `HTTP ${result.status}`)
            setPhase('failed')
            setMessage(`${dict.failed}: ${detail}`)
          })
          .catch((error) => {
            setPhase('failed')
            setMessage(`${dict.failed}: ${error && error.message ? error.message : String(error)}`)
          })
      }, [dict, phase])
      return { phase, message, restart, dict }
    }

    function useReload() {
      const [phase, setPhase] = useState('idle')
      const [message, setMessage] = useState('')
      const dict = lang()
      const reload = useCallback(() => {
        if (phase === 'sending') return
        setPhase('sending')
        setMessage(dict.reloading)
        postJson('/hot-apply/apply', { cause: 'manual' })
          .then((result) => {
            setPhase('idle')
            const applied = result.data && result.data.lastApply
            setMessage(applied && applied.status === 'applied' ? dict.reloadDone : dict.reloadDone)
          })
          .catch(() => {
            setPhase('idle')
            setMessage(dict.reloadDone)
          })
      }, [dict, phase])
      return { reload, reloading: phase === 'sending', message, dict }
    }

    const cardStyle = {
      border: '1px solid currentColor',
      borderRadius: 10,
      padding: '14px 16px',
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      maxWidth: 520,
    }

    const primaryStyle = {
      appearance: 'none',
      border: '0',
      borderRadius: 8,
      padding: '8px 16px',
      font: 'inherit',
      fontWeight: 600,
      cursor: 'pointer',
      background: 'currentColor',
      alignSelf: 'flex-start',
    }

    const plainStyle = {
      appearance: 'none',
      border: '1px solid currentColor',
      borderRadius: 8,
      padding: '6px 12px',
      font: 'inherit',
      cursor: 'pointer',
      background: 'transparent',
      alignSelf: 'flex-start',
    }

    const hintStyle = { fontSize: 12, opacity: 0.7, lineHeight: 1.6 }
    const messageStyle = { fontSize: 12, lineHeight: 1.5 }

    function RestartPanel() {
      const { phase, message, restart, dict } = useRestart()
      const reload = useReload()
      const status = useStatus(true)
      const busy = phase === 'sending' || phase === 'sent'
      const active =
        status && status.active
          ? (status.active.turns || 0) + (status.active.jobs || 0)
          : 0
      const supported = !(status && status.restart && status.restart.supported === false)
      const reason = status && status.restart ? status.restart.reason : undefined
      const unsupportedText = (reason && dict.reasons && dict.reasons[reason]) || dict.unsupported

      return h(
        'div',
        { style: cardStyle },
        h('div', { style: { fontSize: 15, fontWeight: 600 } }, dict.tabTitle),
        h('div', { style: hintStyle }, dict.tabIntro),
        h(
          'div',
          { style: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' } },
          h(
            'button',
            {
              type: 'button',
              style: Object.assign({}, primaryStyle, busy || !supported ? { opacity: 0.6, cursor: 'default' } : null),
              disabled: busy || !supported,
              onClick: restart,
            },
            busy ? dict.restarting : dict.confirm,
          ),
          h(
            'button',
            {
              type: 'button',
              style: plainStyle,
              disabled: reload.reloading,
              onClick: reload.reload,
            },
            reload.reloading ? dict.reloading : dict.reload,
          ),
        ),
        !supported ? h('div', { style: messageStyle }, unsupportedText) : null,
        active > 0 ? h('div', { style: messageStyle }, dict.statusRunning) : null,
        message ? h('div', { style: messageStyle }, message) : null,
        reload.message ? h('div', { style: messageStyle }, reload.message) : null,
        status
          ? h(
              'div',
              { style: hintStyle },
              `${status.version ? `v${status.version}` : ''} · ${
                status.lastApply && status.lastApply.status === 'applied' ? dict.statusReady : dict.statusNeeded
              }`,
            )
          : null,
      )
    }

    function RestartPill() {
      const { phase, restart, dict } = useRestart()
      const busy = phase === 'sending' || phase === 'sent'
      return h(
        'button',
        {
          type: 'button',
          title: dict.restart,
          onClick: restart,
          disabled: busy,
          style: {
            position: 'fixed',
            right: 18,
            bottom: 190,
            zIndex: 40,
            pointerEvents: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '7px 12px',
            borderRadius: 999,
            border: '1px solid currentColor',
            background: 'transparent',
            color: 'inherit',
            font: 'inherit',
            fontSize: 12,
            cursor: busy ? 'default' : 'pointer',
            opacity: busy ? 0.7 : 0.9,
          },
        },
        busy ? dict.restarting : dict.restart,
      )
    }

    function RestartAction(props) {
      const { phase, restart, dict } = useRestart()
      const busy = phase === 'sending' || phase === 'sent'
      return h(
        'button',
        {
          type: 'button',
          style: Object.assign({}, plainStyle, busy ? { opacity: 0.6 } : null),
          disabled: busy,
          onClick: restart,
        },
        busy ? dict.restarting : dict.restart,
      )
    }

    function apply(ctx) {
      ctx.slots.inject('settings.plugins.tab', () =>
        ctx.slots.register(
          { name: 'settings.plugins.tab', id: 'hot-apply', order: 20, label: '一键重启' },
          RestartPanel,
        ),
      )

      ctx.slots.inject('plugins.detail.actions', () =>
        ctx.slots.register(
          { name: 'plugins.detail.actions', id: 'hot-apply-restart', order: 40, label: () => '重启 DSH' },
          RestartAction,
        ),
      )

      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: 'hot-apply.restart', order: 900 }, RestartPill),
      )
    }

    return { inject: ['slots'], apply }
  },
})
