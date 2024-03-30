import { Editor, EditorChange, EditorTransaction } from "obsidian";
import { SmartTypographySettings } from "types";

/**
 * Apply quotes to the selected text or the entire document.
 * @param settings - The plugin settings.
 * @param editor - The editor instance.
 */
export function applyQuotes(settings: SmartTypographySettings, editor: Editor): void {

    // for some reason, editor.somethingSelected is always true? Kinda defeats the point, but what do I know?
    var somethingSelected = true;
    var selections = editor.listSelections();
    if(selections.length === 1) {
        var selection = selections[0];
        if(selection.head.line == selection.anchor.line && selection.head.ch == selection.anchor.ch)
            somethingSelected = false;
    }

    var transaction: EditorTransaction = { };

    if(somethingSelected){
        transaction.changes = selections.map((selection) => { 
            var from = selection.anchor;
            var to = selection.head;

            if((to.line == from.line && to.ch < from.ch) || to.line < from.line) {
                var temp = from;
                from = to;
                to = temp
            }

            var text = editor.getRange(from, to);
            return {
                from: from,
                to: to,
                text: applyQuotePreferencesToBlob(text, settings)
            };
        });
    } else {
        // If nothing is selected, run formatting on the entire document.
        var changes: EditorChange[] = [];
        var lines = editor.lineCount();
        for(var i = 0; i < lines; i++){
            var line = editor.getLine(i);
            var newLine = applyQuotePreferencesToLine(line, settings);
            if(newLine !== line){
                changes.push({
                    from: {line: i, ch: 0},
                    to: {line: i, ch: line.length},
                    text: newLine
                });
            }
        }
        transaction.changes = changes;
    }

    editor.transaction(transaction);
}

function applyQuotePreferencesToBlob(text: string, settings: SmartTypographySettings): string {
    var func = (line: string) => applyQuotePreferencesToLine(line, settings);
    return text.split("\n").map(func).join("\n");
}


// These rules are dumb, and whoever wrote them should feel bad.
// Let's step through these...

// Double quotations are easy. 
// If a double quote is at the beginning of a line, or if it is preceded by a space, then it is an opening quote.
// If it is at the end of a line, or if it is followed by a space, then it is a closing quote.

// It's these damn single quotes that make me want to pull my hair out.
// A single quote is only an opening quote if it begins a quotation.
// Otherwise, for contractions or to end a quotation, it should be a closing quote.
// Yes, technically it's an apostrophe, but it's the same symbol as a closing quote!
// But because of the apostrophe problem, it's neigh impossible to tell whether a single quote signifies a contraction or a quotation.
// At least, programmatically, and without having to involve some stupid A.I. thing (sorry copilot).

// I'm going to try to solve the easy cases at least: when a single quote appears in the middle of a word, it should be a closing quote.
// The rest, I'll just have to guess on. I'm sorry, but I'm not going to write a full NLP parser for this.
// Some guessing rules: assume that the first single quote at the beginning of a word is an opening quote.
// If there is no possible matching closing quote candidate (i.e., one that appears at the end of a word), then assume instead that it was an apostrpohe.
// Sorry if you're doing a multi-paragraph quote; I'm going to consider lines in isolation for simplicity.
// Sorry if you have the 'n' contraction; reconsider your life.

// Don't even get me started on single-quotes nested inside double-quotes.

enum QuotePosition {
    Opening, Closing, Enclosed
}

interface QuoteInfo {
    isSingle: boolean; // always true for me, amirite?
    index: number;
    position: QuotePosition;
}

function applyQuotePreferencesToLine(line: string, settings: SmartTypographySettings): string {
    var newline: string[] = [];
    if(line == null || line.length === 0)
        return "";
    
    var nextChar = line.charAt(0);
    var char = null;
    var i = 0;

    var quotes: QuoteInfo[] = [];

    while(i < line.length) {
        var prevChar = char;
        char = nextChar;
        nextChar = i < line.length - 1 ? line.charAt(i + 1) : null;

        newline.push(char);

        if(char === '"' || char === "'"){ // javascript is my passion.
            var isWsBefore = isWhitespace(prevChar);
            var isWsAfter = isWhitespace(nextChar);

            var pos: QuotePosition = QuotePosition.Opening;
            if(isWsBefore) {
                pos = QuotePosition.Opening;
            } else if(isWsAfter) {
                pos = QuotePosition.Closing;
            } else {
                pos = QuotePosition.Enclosed;
            }

            quotes.push({
                isSingle: char === "'",
                index: i,
                position: pos
            });
        }

        i++;
    }

    quotes.forEach((quote) => {
        var c: string;
        if(quote.isSingle) {
            // TODO - eternal improvement b/c single quotes SUCK.
            if(quote.position === QuotePosition.Opening) {
                c = settings.openSingle;
            } else {
                c = settings.closeSingle;
            }
        }
        else {
            if(quote.position === QuotePosition.Closing) {
                c = settings.closeDouble;
            } else {
                c = settings.openDouble;
            }
        }
        newline[quote.index] = c;
    });

    return newline.join("");
}

function isWhitespace(c: string | null): boolean {
    if(c == null)
        return true;

    return c === " " || c === "\t";
}
