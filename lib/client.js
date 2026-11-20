/**
 * @local/dsh-ssq 的浏览器半侧：设置里的「双色球」配置页 + 「插件」页里本行的「配置」入口。
 *
 * 数据来自 Host 的 settings 服务：ctx.configForms.get(条目 id) 给出一个共享表单，
 * 读快照、订阅变化、mutate/unset 写回（带 revision 防并发覆盖）。
 * 宿主侧只需要导出带 meta.volatile 的 Config，不用注册 settings 命名空间。
 *
 * 所有字段都是顶层的，所以路径就是 [key]；留空 = unset（回退到组合配置/代码默认值）。
 */

window.__ModuleLoader__.load({
  id: "dsh-ssq",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");

    /** settings 命名空间 = bundle patch 里那一行的 id。 */
    const NAMESPACE = "ssq-draws";
    /** 「插件」页里本 bundle 那一行的配置 key：<包名>#<行 id>。 */
    const ROW_CONFIG_KEY = "dsh-ssq#ssq-draws";
    const SECTION_ID = "ssq-draws";
    const TITLE = "双色球";

    const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

    /** 一个字段：kind=text 原样写字符串；kind=list 按逗号拆成数字数组。 */
    const FIELDS = [
      {
        kind: "text",
        key: "weeklyTime",
        label: "首次检查时间",
        placeholder: "21:35",
        hint: "HH:mm。开奖日（默认周二/四/日）先跑这一次。",
        validate: (text) => (TIME_PATTERN.test(text) ? null : "要填 HH:mm，例如 21:35。")
      },
      {
        kind: "list",
        key: "weekdays",
        label: "开奖日",
        placeholder: "2,4,7",
        hint: "ISO 星期：周一 1 … 周日 7，逗号分隔。默认 2,4,7（周二/四/日）。",
        min: 1,
        max: 7
      },
      {
        kind: "text",
        key: "timeZone",
        label: "时区",
        placeholder: "Asia/Shanghai",
        hint: "IANA 时区。开奖时间、补抓时间都按它换算。"
      },
      {
        kind: "list",
        key: "retryOffsetsMinutes",
        label: "补抓间隔（分钟）",
        placeholder: "5,15,45",
        hint: "相对「当次检查」的分钟数。默认 5,15,45 → 21:40 / 21:50 / 22:20。",
        min: 1,
        max: 120
      },
      {
        kind: "text",
        key: "nextMorningTime",
        label: "次日兜底时间",
        placeholder: "06:00",
        hint: "补抓阶梯用尽仍未开奖时，次日这个时间再查一次。",
        validate: (text) => (TIME_PATTERN.test(text) ? null : "要填 HH:mm，例如 06:00。")
      },
    ];

    const styles = {
      root: {
        display: "flex",
        flexDirection: "column",
        gap: "14px",
        padding: "16px",
        border: "0.5px solid var(--dsw-alias-border-l2, #e5e7eb)",
        borderRadius: "12px",
        background: "var(--dsw-alias-bg-layer-3, #ffffff)"
      },
      header: { display: "flex", flexDirection: "column", gap: "4px" },
      title: { margin: 0, fontSize: "15px", fontWeight: 600, color: "var(--dsw-alias-label-primary, #111827)" },
      description: { margin: 0, fontSize: "12px", lineHeight: 1.6, color: "var(--dsw-alias-label-tertiary, #6b7280)" },
      field: { display: "flex", flexDirection: "column", gap: "6px" },
      label: { fontSize: "13px", fontWeight: 500, color: "var(--dsw-alias-label-primary, #111827)" },
      input: {
        boxSizing: "border-box",
        width: "100%",
        height: "34px",
        padding: "0 12px",
        border: "0.5px solid var(--dsw-alias-border-l4, #d1d5db)",
        borderRadius: "8px",
        background: "var(--dsw-alias-bg-layer-3, #ffffff)",
        color: "var(--dsw-alias-label-primary, #111827)",
        fontSize: "13px",
        fontFamily: "inherit"
      },
      hint: { margin: 0, fontSize: "12px", lineHeight: 1.5, color: "var(--dsw-alias-label-tertiary, #6b7280)" },
      ok: { margin: 0, fontSize: "12px", lineHeight: 1.5, color: "var(--dsw-alias-label-success, #15803d)" },
      error: { margin: 0, fontSize: "12px", lineHeight: 1.5, color: "var(--dsw-alias-label-error, #dc2626)" },
      actions: { display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "2px" },
      primary: {
        height: "32px",
        padding: "0 14px",
        border: "0.5px solid transparent",
        borderRadius: "8px",
        background: "var(--dsw-alias-bg-brand, #2563eb)",
        color: "var(--dsw-alias-label-on-brand, #ffffff)",
        fontSize: "13px",
        fontWeight: 500,
        cursor: "pointer"
      },
      secondary: {
        height: "32px",
        padding: "0 14px",
        border: "0.5px solid var(--dsw-alias-border-l4, #d1d5db)",
        borderRadius: "8px",
        background: "transparent",
        color: "var(--dsw-alias-label-primary, #111827)",
        fontSize: "13px",
        cursor: "pointer"
      },
      disabled: { opacity: 0.55, cursor: "not-allowed" }
    };

    const displayValue = (raw) => {
      if (Array.isArray(raw)) return raw.join(",");
      return raw === undefined || raw === null ? "" : String(raw);
    };

    const parseList = (text, field) => {
      const parts = text.split(/[,，\s]+/).filter(Boolean);
      const numbers = [];
      for (const part of parts) {
        const value = Number(part);
        if (!Number.isInteger(value) || value < field.min || value > field.max) {
          return { error: `「${field.label}」只能填 ${field.min}-${field.max} 的整数，用逗号分隔。` };
        }
        if (!numbers.includes(value)) numbers.push(value);
      }
      return { value: numbers.sort((a, b) => a - b) };
    };

    function SsqSettings(props) {
      const form = props.form;
      const subscribe = React.useCallback((listener) => form.subscribe(listener), [form]);
      const read = React.useCallback(() => form.getSnapshot(), [form]);
      const snapshot = React.useSyncExternalStore(subscribe, read, read);

      const [draft, setDraft] = React.useState({});
      const [saving, setSaving] = React.useState(false);
      const [message, setMessage] = React.useState(null);

      const writable = Boolean(snapshot) && snapshot.status === "ready" && snapshot.writable !== false;
      const disabled = !writable || saving;

      const edited = (key) => Object.prototype.hasOwnProperty.call(draft, key);
      const valueOf = (field) => {
        if (edited(field.key)) return draft[field.key];
        const current = snapshot && snapshot.value ? snapshot.value[field.key] : undefined;
        return displayValue(current);
      };
      const edit = (key, next) => setDraft((previous) => ({ ...previous, [key]: next }));

      const save = async () => {
        if (!writable) return;
        const ops = [];
        for (const field of FIELDS) {
          if (!edited(field.key)) continue;
          const text = String(draft[field.key] ?? "").trim();
          if (text === "") {
            ops.push({ op: "unset", path: [field.key] });
            continue;
          }
          if (field.kind === "list") {
            const parsed = parseList(text, field);
            if (parsed.error) {
              setMessage({ kind: "error", text: parsed.error });
              return;
            }
            ops.push({ op: "set", path: [field.key], value: parsed.value });
            continue;
          }
          if (typeof field.validate === "function") {
            const invalid = field.validate(text);
            if (invalid) {
              setMessage({ kind: "error", text: `「${field.label}」${invalid}` });
              return;
            }
          }
          ops.push({ op: "set", path: [field.key], value: text });
        }

        if (ops.length === 0) {
          setMessage({ kind: "error", text: "没有改动需要保存。" });
          return;
        }

        setSaving(true);
        setMessage(null);
        try {
          const accepted = await form.mutate(ops, snapshot.revision);
          if (!accepted) {
            setMessage({ kind: "error", text: "Host 没有接受这次修改（可能刚被别处改过，或字段没通过校验）。草稿还在，请再试一次。" });
            return;
          }
          setDraft({});
          setMessage({ kind: "ok", text: "已保存，下一次检查（ssq_check）立即生效。" });
        } catch (error) {
          setMessage({ kind: "error", text: "没有保存成功：" + (error && error.message ? error.message : String(error)) });
        } finally {
          setSaving(false);
        }
      };

      const resetAll = async () => {
        if (!writable) return;
        setSaving(true);
        setMessage(null);
        try {
          const accepted = await form.mutate(
            FIELDS.map((field) => ({ op: "unset", path: [field.key] })),
            snapshot.revision
          );
          if (!accepted) {
            setMessage({ kind: "error", text: "Host 没有接受这次修改，请重试。" });
            return;
          }
          setDraft({});
          setMessage({ kind: "ok", text: "已恢复默认（回到组合配置里的值）。" });
        } catch (error) {
          setMessage({ kind: "error", text: "恢复默认失败：" + (error && error.message ? error.message : String(error)) });
        } finally {
          setSaving(false);
        }
      };

      if (!snapshot || snapshot.status === "unavailable") {
        return React.createElement(
          "div",
          { style: styles.root },
          React.createElement("h3", { style: styles.title }, TITLE),
          React.createElement("p", { style: styles.hint }, "当前连接没有开放「双色球」插件的设置。")
        );
      }

      return React.createElement(
        "div",
        { style: styles.root },
        React.createElement(
          "div",
          { style: styles.header },
          React.createElement("h3", { style: styles.title }, TITLE + "开奖抓取"),
          React.createElement(
            "p",
            { style: styles.description },
            "开奖夜（默认周二/周四/周日）自动抓取数据；没开奖就按间隔补抓，次日再兜底。保存后不需要重启。"
          )
        ),
        FIELDS.map((field) =>
          React.createElement(
            "div",
            { key: field.key, style: styles.field },
            React.createElement("label", { style: styles.label }, field.label),
            React.createElement("input", {
              style: styles.input,
              type: "text",
              placeholder: field.placeholder,
              value: valueOf(field),
              disabled,
              onChange: (event) => edit(field.key, event.target.value)
            }),
            React.createElement("p", { style: styles.hint }, field.hint)
          )
        ),
        message === null
          ? null
          : React.createElement("p", { style: message.kind === "ok" ? styles.ok : styles.error }, message.text),
        React.createElement(
          "div",
          { style: styles.actions },
          React.createElement(
            "button",
            { type: "button", style: disabled ? { ...styles.primary, ...styles.disabled } : styles.primary, disabled, onClick: save },
            saving ? "保存中…" : "保存"
          ),
          React.createElement(
            "button",
            { type: "button", style: disabled ? { ...styles.secondary, ...styles.disabled } : styles.secondary, disabled, onClick: resetAll },
            "恢复默认"
          )
        )
      );
    }

    /** 与官方设置页一致：硬依赖 slots + configForms。 */
    const inject = ["slots", "configForms"];

    /**
     * 注册两处入口：
     *   · settings.section   —— 设置里的独立分区；
     *   · plugins.row.config —— 「插件」页里本 bundle 那一行的「配置」按钮。
     * 两个入口都只在 Host 正在 serve 本插件的 settings 命名空间时存在。
     */
    function apply(ctx) {
      const form = ctx.configForms.get(NAMESPACE);
      const Page = () => React.createElement(SsqSettings, { form });

      ctx.effect(
        () =>
          ctx.configForms.whileServed([NAMESPACE], () => {
            const disposers = [];
            disposers.push(
              ctx.slots.inject("settings.section", () =>
                ctx.slots.register(
                  {
                    name: "settings.section",
                    id: SECTION_ID,
                    // 排在内置分区（General 0 / Models 10 / 插件 15 / Agent 预设 20）之后
                    order: 26,
                    label: () => TITLE
                  },
                  Page
                )
              )
            );
            disposers.push(
              ctx.slots.inject("plugins.row.config", () =>
                ctx.slots.register({ name: "plugins.row.config", key: ROW_CONFIG_KEY }, Page)
              )
            );
            return () => {
              for (const dispose of disposers) {
                try {
                  dispose();
                } catch {
                  /* 已释放 */
                }
              }
            };
          }),
        "dsh-ssq: config surfaces"
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
