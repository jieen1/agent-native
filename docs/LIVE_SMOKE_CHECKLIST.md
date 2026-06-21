# Live 端到端冒烟清单(待用户接好 OAuth 后手动跑)

这些是**唯一需要真实数据源**的验收项 —— 不计入阶段验收门(§1.5.24)。代码实施期间各阶段用 mock 验证逻辑;用户接好对应 OAuth/凭证后,在此手动跑一遍确认真实数据贯通。

前置:对应数据源 app 本地以生产模式跑起来(`AGENT_MODE=production` 或 `NODE_ENV=production`,§1.5.4),端口按 `.agent-native/workspace-apps.json`(mail 8110 / calendar 8111 / brain 8112 / analytics 8113 / routines 8114 / chief-of-staff 8115)。

## 待跑项(随阶段累加)

- [ ] **B2 · mail/calendar fan-out**:在 chief-of-staff 触发一次 `compile-briefing`(kind:adhoc),目标 mail+calendar 都返回 `status:ok`、`responseText` 非空且含可解析深链;briefing 行落库、面板渲染两源真实数据。前置:mail + calendar OAuth(Google)已连、各列得出真实邮件/日程。
- [ ] **B3 · brain/analytics + 合成**:四源(mail/calendar/brain/analytics)同进一份 briefing,各 `status:ok`;agent 经 `update-briefing` 写出非空 `summaryMd`(非纯拼接);深链点击跳回对应源 app 正确对象。前置:brain 至少一个源已接、analytics 维护了一个约定命名的「每日指标」analysis(§1.5.13)。
- [ ] **A3 · 跨 app 事件(真实源)**:在某真实数据源 app(如 plan/mail)真实 `emit` 一个事件,Routines 事件桥 poller 拉到并触发订阅 routine。(注:A3 阶段验收已用自家 routines↔chief-of-staff 互发事件覆盖逻辑;此项是真实源 app 的额外确认。)
- [ ] **Phase C · 自动简报**:一条 `30 8 * * 1-5` schedule routine 经 A2A 驱动 chief-of-staff 编译并润色当日 morning 简报,真实四源数据。

> 阶段推进**不等**本清单;本清单是 OAuth 就绪后的最终真实性确认。
