// dsh-dock · 客户端共享工具（外壳与功能模块共用；提取功能模块独立成包时随包复制）
import react from "react";

/**
 * 功能视图错误边界：外部功能包注册进来的视图渲染抛错时降级为错误提示，
 * 不拖垮整个功能坞面板（内置视图不包——它们与外壳同包发布、同生命周期）。
 */
export class FeatureBoundary extends react.Component {
	constructor(props) {
		super(props);
		this.state = { error: null };
	}
	static getDerivedStateFromError(error) {
		return { error: error };
	}
	render() {
		if (this.state.error) {
			const msg = this.state.error && this.state.error.message ? this.state.error.message : String(this.state.error);
			return react.createElement("div", { className: "dockm-note dockm-err" },
				"功能视图渲染出错：" + msg + "（该功能来自外部包，不影响面板其他功能）");
		}
		return this.props.children;
	}
}
