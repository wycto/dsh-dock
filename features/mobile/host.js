// dsh-dock · 功能模块【手机适配】· 宿主半部（开关占位）
//
// 手机适配的实现全部在客户端半部（features/mobile/view.js）：样式与行为在 Overlay
// 挂载时注入、卸载时移除，所以这个宿主半部**什么都不注入**，只保留一个 feature 描述符，
// 让功能开关能照常持久化（settings 的 features 表按 id 记开关，路由 /dsh-dock/features
// 用 FEATURES 列表校验 id 是否存在）。
//
// 为什么不再经 webServer.tapIndex 内联注入 index.html：
//   · 旧版这样做必须重启 dsh web 才能彻底摘除注入的 <style>/<script>；用户要求
//     「关闭就要关闭得彻底、不能干扰原来的」。改成客户端运行时注入 + 卸载清理后，
//     关闭开关的瞬间样式、body 属性、遮罩/按钮、监听器、观察器、定时器全部消失，
//     index.html 里一个标记都不残留，也不动 <meta viewport>。
export const feature = {
	id: 'mobile',
	name: '手机适配',
	description: '手机/窄屏体验优化（客户端运行时注入，关闭后零残留）：16px 输入防缩放、触控热区、代码块滚动、会话 chip 收起、设置弹层单列与旧版抽屉兜底',
	defaultEnabled: false,
	setup() {
		// 无宿主副作用；返回空清理函数以匹配生命周期约定。
		return () => {}
	},
}
