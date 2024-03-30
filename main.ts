import { App, Editor, MarkdownView, Plugin, PluginSettingTab, Setting } from "obsidian";
import {
  ChangeSpec,
  EditorSelection,
  EditorState,
  StateEffect,
  StateField,
  TransactionSpec,
} from "@codemirror/state";
import {
  InputRule,
  arrowRules,
  comparisonRules,
  dashRules,
  dashRulesSansEnDash,
  ellipsisRules,
  fractionRules,
  guillemetRules,
  smartQuoteRules,
} from "inputRules";
import {
  LegacyInputRule,
  legacyArrowRules,
  legacyComparisonRules,
  legacyDashRules,
  legacyEllipsisRules,
  legacyGuillemetRules,
  legacySmartQuoteRules,
} from "legacyInputRules";
import { syntaxTree, tokenClassNodeProp } from "@codemirror/language";

import { SmartTypographySettings } from "types";
import { Tree } from "@lezer/common";
import { applyQuotes } from "apply-quotes";

const DEFAULT_SETTINGS: SmartTypographySettings = {
  curlyQuotes: true,
  emDash: true,
  ellipsis: true,
  arrows: true,
  comparisons: true,
  fractions: false,
  guillemets: false,
  skipEnDash: false,

  openSingle: "‘",
  closeSingle: "’",

  openDouble: "“",
  closeDouble: "”",

  openGuillemet: "«",
  closeGuillemet: "»",

  leftArrow: "←",
  rightArrow: "→",
};

export default class SmartTypography extends Plugin {
  settings: SmartTypographySettings;
  inputRules: InputRule[];
  inputRuleMap: Record<string, InputRule[]>;

  legacyInputRules: LegacyInputRule[];
  legacyLastUpdate: WeakMap<CodeMirror.Editor, LegacyInputRule>;

  buildInputRules() {
    this.legacyInputRules = [];
    this.inputRules = [];
    this.inputRuleMap = {};

    if (this.settings.emDash) {
      if (this.settings.skipEnDash) {
        this.inputRules.push(...dashRulesSansEnDash);
      } else {
        this.inputRules.push(...dashRules);
      }

      this.legacyInputRules.push(...legacyDashRules);
    }

    if (this.settings.ellipsis) {
      this.inputRules.push(...ellipsisRules);
      this.legacyInputRules.push(...legacyEllipsisRules);
    }

    if (this.settings.curlyQuotes) {
      this.inputRules.push(...smartQuoteRules);
      this.legacyInputRules.push(...legacySmartQuoteRules);
    }

    if (this.settings.arrows) {
      this.inputRules.push(...arrowRules);
      this.legacyInputRules.push(...legacyArrowRules);
    }

    if (this.settings.guillemets) {
      this.inputRules.push(...guillemetRules);
      this.legacyInputRules.push(...legacyGuillemetRules);
    }

    if (this.settings.comparisons) {
      this.inputRules.push(...comparisonRules);
      this.legacyInputRules.push(...legacyComparisonRules);
    }

    if (this.settings.fractions) {
      this.inputRules.push(...fractionRules);
    }

    this.inputRules.forEach((rule) => {
      if (this.inputRuleMap[rule.trigger] === undefined) {
        this.inputRuleMap[rule.trigger] = [];
      }

      this.inputRuleMap[rule.trigger].push(rule);
    });
  }

  async onload() {
    await this.loadSettings();

    this.addSettingTab(new SmartTypographySettingTab(this.app, this));

    // Codemirror 6
    //
    // When smart typography overrides changes, we want to keep a record
    // so we can undo them when the user presses backspace
    const storeTransaction = StateEffect.define<TransactionSpec>();
    const prevTransactionState = StateField.define<TransactionSpec | null>({
      create() {
        return null;
      },
      update(oldVal, tr) {
        for (let e of tr.effects) {
          if (e.is(storeTransaction)) {
            return e.value;
          }
        }

        if (
          !oldVal ||
          tr.isUserEvent("input") ||
          tr.isUserEvent("delete.forward") ||
          tr.isUserEvent("delete.cut") ||
          tr.isUserEvent("move") ||
          tr.isUserEvent("select") ||
          tr.isUserEvent("undo")
        ) {
          return null;
        }

        return oldVal;
      },
    });

    this.registerEditorExtension([
      prevTransactionState,
      EditorState.transactionFilter.of((tr) => {
        // Revert any stored changes on delete
        if (
          tr.isUserEvent("delete.backward") ||
          tr.isUserEvent("delete.selection")
        ) {
          return tr.startState.field(prevTransactionState, false) || tr;
        }

        // If the user hasn't typed, or the doc hasn't changed, return early
        if (!tr.isUserEvent("input.type") || !tr.docChanged) {
          return tr;
        }

        // Cache the syntax tree if we end up accessing it
        let tree: Tree = null;

        // Memoize any positions we check so we can avoid some work
        const seenPositions: Record<number, boolean> = {};

        const canPerformReplacement = (pos: number) => {
          if (seenPositions[pos] !== undefined) {
            return seenPositions[pos];
          }

          if (!tree) tree = syntaxTree(tr.state);

          const nodeProps = tree
            .resolveInner(pos, 1)
            .type.prop(tokenClassNodeProp);

          if (nodeProps && ignoreListRegEx.test(nodeProps)) {
            seenPositions[pos] = false;
          } else {
            seenPositions[pos] = true;
          }

          return seenPositions[pos];
        };

        // Store a list of changes and specs to revert these changes
        const changes: ChangeSpec[] = [];
        const reverts: ChangeSpec[] = [];

        const registerChange = (change: ChangeSpec, revert: ChangeSpec) => {
          changes.push(change);
          reverts.push(revert);
        };

        const contextCache: Record<number, string> = {};
        let newSelection = tr.selection;

        tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
          const insertedText = inserted.sliceString(0, 0 + inserted.length);
          const matchedRules = this.inputRuleMap[insertedText];

          if (!matchedRules) {
            return;
          }

          for (let rule of matchedRules) {
            // If we're in a codeblock, etc, return early, no need to continue checking
            if (!canPerformReplacement(fromA)) return;

            // Grab and cache three chars before the one being inserted
            if (contextCache[fromA] === undefined) {
              contextCache[fromA] = tr.newDoc.sliceString(fromB - 3, fromB);
            }

            const context = contextCache[fromA];

            if (!rule.contextMatch.test(context)) {
              continue;
            }

            const insert =
              typeof rule.to === "string" ? rule.to : rule.to(this.settings);
            const replacementLength = rule.from.length - rule.trigger.length;
            const insertionPoint = fromA - replacementLength;
            const reversionPoint = fromB - replacementLength;

            registerChange(
              {
                from: insertionPoint,
                to: insertionPoint + replacementLength,
                insert,
              },
              {
                from: reversionPoint,
                to: reversionPoint + insert.length,
                insert: rule.from,
              }
            );

            const selectionAdjustment = rule.from.length - insert.length;

            newSelection = EditorSelection.create(
              newSelection.ranges.map((r) =>
                EditorSelection.range(
                  r.anchor - selectionAdjustment,
                  r.head - selectionAdjustment
                )
              )
            );

            return;
          }
        }, false);

        // If we have any changes, construct a transaction spec
        if (changes.length) {
          return [
            {
              effects: storeTransaction.of({
                effects: storeTransaction.of(null),
                selection: tr.selection,
                scrollIntoView: tr.scrollIntoView,
                changes: reverts,
              }),
              selection: newSelection,
              scrollIntoView: tr.scrollIntoView,
              changes,
            },
          ];
        }

        return tr;
      }),
    ]);

    // Codemirror 5
    this.legacyLastUpdate = new WeakMap();
    this.registerCodeMirror((cm: CodeMirror.Editor) => {
      cm.on("beforeChange", this.beforeChangeHandler);
    });

    this.addCommand({
        id: "smart-typography-apply-quotations",
        name: "Apply Quotation Typography",
        editorCallback: (editor: Editor, _view: MarkdownView) => applyQuotes(this.settings, editor)
    });
  }

  onunload() {
    this.legacyLastUpdate = null;
    this.app.workspace.iterateCodeMirrors((cm) => {
      cm.off("beforeChange", this.beforeChangeHandler);
    });
  }

  beforeChangeHandler = (
    instance: CodeMirror.Editor,
    delta: CodeMirror.EditorChangeCancellable
  ) => {
    if (this.legacyLastUpdate.has(instance) && delta.origin === "+delete") {
      const revert = this.legacyLastUpdate.get(instance).performRevert;

      if (revert) {
        revert(instance, delta, this.settings);
        this.legacyLastUpdate.delete(instance);
      }
      return;
    }

    if (delta.origin === undefined && delta.text.length === 1) {
      const input = delta.text[0];

      for (let rule of this.legacyInputRules) {
        if (!(rule.matchTrigger instanceof RegExp)) {
          continue;
        }

        if (rule.matchTrigger.test(input)) {
          rule.performUpdate(instance, delta, this.settings);
          return;
        }
      }

      return;
    }

    if (delta.origin === "+input" && delta.text.length === 1) {
      const input = delta.text[0];
      const rules = this.legacyInputRules.filter((r) => {
        return typeof r.matchTrigger === "string" && r.matchTrigger === input;
      });

      if (rules.length === 0) {
        if (this.legacyLastUpdate.has(instance)) {
          this.legacyLastUpdate.delete(instance);
        }
        return;
      }

      let str = input;

      if (delta.to.ch > 0) {
        str = `${instance.getRange(
          { line: delta.to.line, ch: 0 },
          delta.to
        )}${str}`;
      }

      for (let rule of rules) {
        if (rule.matchRegExp && rule.matchRegExp.test(str)) {
          if (
            shouldCheckTextAtPos(instance, delta.from) &&
            shouldCheckTextAtPos(instance, delta.to)
          ) {
            this.legacyLastUpdate.set(instance, rule);
            rule.performUpdate(instance, delta, this.settings);
          }
          return;
        }
      }
    }

    if (this.legacyLastUpdate.has(instance)) {
      this.legacyLastUpdate.delete(instance);
    }
  };

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.buildInputRules();
  }

  async saveSettings() {
    this.buildInputRules();
    await this.saveData(this.settings);
  }
}

class SmartTypographySettingTab extends PluginSettingTab {
  plugin: SmartTypography;

  constructor(app: App, plugin: SmartTypography) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    let { containerEl } = this;

    containerEl.empty();

    new Setting(containerEl)
      .setName("Curly Quotes")
      .setDesc(
        "Double and single quotes will be converted to curly quotes (“” & ‘’)"
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.curlyQuotes)
          .onChange(async (value) => {
            this.plugin.settings.curlyQuotes = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Open double quote character")
      .addText((text) => {
        text
          .setValue(this.plugin.settings.openDouble)
          .onChange(async (value) => {
            if (!value) return;
            if (value.length > 1) {
              text.setValue(value[0]);
              return;
            }

            this.plugin.settings.openDouble = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Close double quote character")
      .addText((text) => {
        text
          .setValue(this.plugin.settings.closeDouble)
          .onChange(async (value) => {
            if (!value) return;
            if (value.length > 1) {
              text.setValue(value[0]);
              return;
            }
            this.plugin.settings.closeDouble = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Open single quote character")
      .addText((text) => {
        text
          .setValue(this.plugin.settings.openSingle)
          .onChange(async (value) => {
            if (!value) return;
            if (value.length > 1) {
              text.setValue(value[0]);
              return;
            }
            this.plugin.settings.openSingle = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Close single quote character")
      .addText((text) => {
        text
          .setValue(this.plugin.settings.closeSingle)
          .onChange(async (value) => {
            if (!value) return;
            if (value.length > 1) {
              text.setValue(value[0]);
              return;
            }
            this.plugin.settings.closeSingle = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Dashes")
      .setDesc(
        "Two dashes (--) will be converted to an en-dash (–). And en-dash followed by a dash will be converted to and em-dash (—). An em-dash followed by a dash will be converted into three dashes (---)"
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.emDash).onChange(async (value) => {
          this.plugin.settings.emDash = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Skip en-dash")
      .setDesc(
        "When enabled, two dashes will be converted to an em-dash rather than an en-dash."
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.skipEnDash)
          .onChange(async (value) => {
            this.plugin.settings.skipEnDash = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Ellipsis")
      .setDesc("Three periods (...) will be converted to an ellipses (…)")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.ellipsis)
          .onChange(async (value) => {
            this.plugin.settings.ellipsis = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Guillemets")
      .setDesc("<< | >> will be converted to « | »")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.guillemets)
          .onChange(async (value) => {
            this.plugin.settings.guillemets = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl).setName("Open guillemet").addText((text) => {
      text
        .setValue(this.plugin.settings.openGuillemet)
        .onChange(async (value) => {
          if (!value) return;

          this.plugin.settings.openGuillemet = value;
          await this.plugin.saveSettings();
        });
    });

    new Setting(containerEl).setName("Close guillemet").addText((text) => {
      text
        .setValue(this.plugin.settings.closeGuillemet)
        .onChange(async (value) => {
          if (!value) return;

          this.plugin.settings.closeGuillemet = value;
          await this.plugin.saveSettings();
        });
    });

    new Setting(containerEl)
      .setName("Arrows")
      .setDesc("<- | -> will be converted to ← | →")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.arrows).onChange(async (value) => {
          this.plugin.settings.arrows = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl).setName("Left arrow character").addText((text) => {
      text.setValue(this.plugin.settings.leftArrow).onChange(async (value) => {
        if (!value) return;
        if (value.length > 1) {
          text.setValue(value[0]);
          return;
        }
        this.plugin.settings.leftArrow = value;
        await this.plugin.saveSettings();
      });
    });

    new Setting(containerEl)
      .setName("Right arrow character")
      .addText((text) => {
        text
          .setValue(this.plugin.settings.rightArrow)
          .onChange(async (value) => {
            if (!value) return;
            if (value.length > 1) {
              text.setValue(value[0]);
              return;
            }
            this.plugin.settings.rightArrow = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Comparison")
      .setDesc("<= | >= | /= will be converted to ≤ | ≥ | ≠")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.comparisons)
          .onChange(async (value) => {
            this.plugin.settings.comparisons = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Fractions")
      .setDesc(
        "1/2 will be converted to ½. Supported UTF-8 fractions: ½, ⅓, ⅔, ¼, ¾, ⅕, ⅖, ⅗, ⅘, ⅙, ⅚, ⅐, ⅛, ⅜, ⅝, ⅞, ⅑, ⅒"
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.fractions)
          .onChange(async (value) => {
            this.plugin.settings.fractions = value;
            await this.plugin.saveSettings();
          });
      });
  }
}

const ignoreListRegEx = /frontmatter|code|math|templater|hashtag/;

function shouldCheckTextAtPos(
  instance: CodeMirror.Editor,
  pos: CodeMirror.Position
) {
  // Empty line
  if (!instance.getLine(pos.line)) {
    return true;
  }

  const tokens = instance.getTokenTypeAt(pos);

  // Plain text line
  if (!tokens) {
    return true;
  }

  // Not codeblock or frontmatter
  if (!ignoreListRegEx.test(tokens)) {
    return true;
  }

  return false;
}
