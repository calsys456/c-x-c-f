// Copyright (c) 2026 The Calendrical System
// SPDX-License-Identifier: 0BSD

import * as vscode from "vscode";
import * as path from "path";
import { existsSync, readFileSync, statSync } from "fs";
import { homedir, platform } from "os";
import { execSync } from "child_process";
import * as fontkit from "fontkit";

// Useless bunch of defs, but who knows? maybe i can copy it from here when i
// need it in future...

interface IconDefinition {
  fontCharacter: string;
  fontColor: string;
}

/**
 * https://code.visualstudio.com/api/extension-guides/file-icon-theme
 */
interface IconTheme {
  iconDefinitions: Record<string, IconDefinition>;
  file?: string;
  folder?: string;
  folderExpanded?: string;
  fileExtensions?: Record<string, string>;
  fileNames?: Record<string, string>;
  languageIds?: Record<string, string>;
  light?: {
    file?: string;
    fileExtensions?: Record<string, string>;
    fileNames?: Record<string, string>;
    languageIds?: Record<string, string>;
  };
  highContrast?: {
    file?: string;
    fileExtensions?: Record<string, string>;
    fileNames?: Record<string, string>;
    languageIds?: Record<string, string>;
  };
}

// seti sucks, it doesn't even have a folder icon
function iconThemeHasFolderIcon(): boolean {
  const iconThemeName = vscode.workspace.getConfiguration().get("workbench.iconTheme");
  if (!iconThemeName || iconThemeName === "vs-seti") {
    return false;
  }
  const iconThemeExt = vscode.extensions.getExtension(iconThemeName as string);
  if (!iconThemeExt) {
    return false;
  }
  const iconThemePath = path.join(
    iconThemeExt?.extensionPath ?? "",
    iconThemeExt?.packageJSON.contributes.iconThemes[0].path ?? "",
  );
  const iconTheme = JSON.parse(readFileSync(iconThemePath, "utf-8")) as IconTheme;
  return !!iconTheme.folder;
}

function expandTilde(namestring: string): string {
  return namestring === "~"
    ? homedir() + path.sep
    : namestring.startsWith("~")
      ? path.join(homedir(), namestring.slice(1))
      : namestring;
}

function collapseTilde(namestring: string): string {
  const homeDir = homedir();
  return namestring === homeDir
    ? "~"
    : namestring.startsWith(homeDir + path.sep)
      ? "~" + namestring.slice(homeDir.length)
      : namestring;
}

function openFolder(namestring: string) {
  if (vscode.workspace.getConfiguration().get("c-x-c-f.openFolderInNewWindow")) {
    vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, null, {
      uri: vscode.Uri.file(namestring),
    });
  } else {
    vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(namestring));
  }
}

function fuzzySearch(target: string, source: string): number {
  let start = -1;
  let score = 0;
  for (const char of target) {
    const newStart = source.indexOf(char, start + 1);
    if (newStart === -1) {
      return Infinity;
    }
    score += newStart - start;
    start = newStart;
  }
  return score;
}

function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) {
    return "0B";
  }
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["B", "K", "M", "G", "T", "P", "E", "Z", "Y"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + sizes[i];
}

/**
 * https://man7.org/linux/man-pages/man2/stat.2.html
 *
 * https://man7.org/linux/man-pages/man7/inode.7.html
 *
 * @param mode stat.st_mode
 * @returns Something like drwxrwxrwx
 */
function formatFileMode(mode: number): string {
  let fileType: string;
  // What about the Windows? emmm, let their taste what unix is like...
  switch (mode & 0o170000) {
    case 0o140000:
      fileType = "s";
      break;
    case 0o120000:
      fileType = "l";
      break;
    case 0o100000:
      fileType = "-";
      break;
    case 0o060000:
      fileType = "b";
      break;
    case 0o040000:
      fileType = "d";
      break;
    case 0o020000:
      fileType = "c";
      break;
    case 0o010000:
      fileType = "p";
      break;
    default:
      // ed man,...
      fileType = "?";
  }
  const permissions = [
    (mode & 0o400) > 0 ? "r" : "-",
    (mode & 0o200) > 0 ? "w" : "-",
    (mode & 0o100) > 0 ? "x" : "-",
    (mode & 0o040) > 0 ? "r" : "-",
    (mode & 0o020) > 0 ? "w" : "-",
    (mode & 0o010) > 0 ? "x" : "-",
    (mode & 0o004) > 0 ? "r" : "-",
    (mode & 0o002) > 0 ? "w" : "-",
    (mode & 0o001) > 0 ? "x" : "-",
  ].join("");
  return fileType + permissions;
}

function fileDescription(namestring: string): {
  mode: string;
  size: string;
  date: string;
  isDir: boolean;
} {
  const stat = statSync(namestring);
  return {
    mode: formatFileMode(stat.mode),
    size: formatBytes(stat.size),
    date: new Date(stat.mtime).toLocaleString(),
    isDir: (stat.mode & 0o170000) === 0o040000,
  };
}

var uiFont: fontkit.Font | undefined;

/**
 * Units Per EM of the UI font
 */
var upm: number | undefined;

class File implements vscode.QuickPickItem {
  static folderIcon: vscode.ThemeIcon;
  label: string = "";
  origLabel: string = "";
  namestring: string;
  resourceUri?: vscode.Uri;
  iconPath?: vscode.IconPath;
  description?: string | undefined;
  alwaysShow = true;
  padding: number;
  get labelText() {
    return this.origLabel;
  }
  set labelText(text: string) {
    // Listen to me you VSCode scum: you can root around all you want, but
    // you'll never match me, and you'll never sort me! You call yourself a
    // programmer?
    // https://cnc.fandom.com/wiki/The_Fox_and_the_Hound
    this.label = [...text].join("\u200B") + "\u2005".repeat(this.padding) + "\t";
    this.origLabel = text;
  }
  constructor(text: string, namestring: string, padding: number, isDir: boolean, desc: string) {
    if (isDir && !text.endsWith(path.sep)) {
      text += path.sep;
    }
    this.padding = padding;
    this.labelText = text;
    this.namestring = namestring;
    this.resourceUri = vscode.Uri.file(namestring);
    this.iconPath = isDir ? File.folderIcon : vscode.ThemeIcon.File;
    this.description = desc;
  }
}

export function activate(context: vscode.ExtensionContext) {
  const fontPath = vscode.workspace.getConfiguration().get("c-x-c-f.UIFont") as string;
  if (fontPath !== "" && existsSync(fontPath)) {
    try {
      const psName = vscode.workspace
        .getConfiguration()
        .get("c-x-c-f.UIFontPostscriptName") as string;
      uiFont = fontkit.openSync(
        fontPath,
        path.extname(fontPath) === ".ttc" && psName !== "" ? psName : undefined,
      ) as fontkit.Font;
    } catch (e) {
      vscode.window.showWarningMessage(
        "Failed to load the font specified by c-x-c-f.UIFont. Check if the path and postscript name (if it's a .ttc) are correct. The extension will try to guess the UI font, but alignment in the picker may be off.",
      );
    }
  } else {
    // private api sucks, but this is what it is, at least for now...
    try {
      switch (platform()) {
        case "darwin":
          uiFont = fontkit.openSync(
            "/System/Library/Fonts/HelveticaNeue.ttc",
            "HelveticaNeue",
          ) as fontkit.Font;
          break;
        case "win32":
          uiFont = fontkit.openSync("C:\\Windows\\Fonts\\segoeui.ttf") as fontkit.Font;
          break;
        default:
          // Who will use Phagspa script in their pathname?
          const [fontPath, psName] = execSync("fc-match -f '%{file}ꡂ%{postscriptname}' sans")
            .toString()
            .trim()
            .split("ꡂ");
          uiFont = fontkit.openSync(fontPath, psName) as fontkit.Font;
      }
      upm = uiFont.unitsPerEm;
    } catch (e) {
      vscode.window.showWarningMessage(
        "Failed to get default UI font of your system. Check if fc-match is installed, or set one by configuring c-x-c-f.UIFont. Alignment in the picker will not work.",
      );
    }
  }
  const disposable = vscode.commands.registerCommand("c-x-c-f.findFile", () => {
    File.folderIcon = iconThemeHasFolderIcon()
      ? vscode.ThemeIcon.Folder
      : new vscode.ThemeIcon("file-directory");
    const quickPick = vscode.window.createQuickPick<File>();
    const currentPath = vscode.window.activeTextEditor?.document.uri.fsPath;
    const currentDir = currentPath
      ? currentPath.endsWith(path.sep)
        ? currentPath
        : path.dirname(currentPath) + path.sep
      : "~/";
    const refresh = () => {
      const value = quickPick.value;
      const isDir = value === "" || value.endsWith(path.sep);
      const fullPath = expandTilde(
        path.isAbsolute(expandTilde(value)) ? value : path.join(currentDir, value),
      );
      const fullDir = isDir ? fullPath : path.dirname(fullPath);
      const dir = isDir ? value : path.dirname(value);
      if (!existsSync(fullDir)) {
        quickPick.items = [];
        return;
      }
      vscode.workspace.fs.readDirectory(vscode.Uri.file(fullDir)).then((entries) => {
        if (
          !path.basename(value).startsWith(".") &&
          !vscode.workspace.getConfiguration().get("c-x-c-f.showHiddenFiles")
        ) {
          entries = entries.filter(([name]) => !name.startsWith("."));
        }
        if (value.endsWith(path.sep)) {
          entries.sort(([aName, aType], [bName, bType]) => {
            return aType === bType
              ? aName.localeCompare(bName)
              : aType === vscode.FileType.Directory
                ? -1
                : 1;
          });
        } else {
          entries = entries.filter(
            ([name]) => fuzzySearch(path.basename(value), name) !== Infinity,
          );
          entries.sort(([aName, aType], [bName, bType]) => {
            const aScore = fuzzySearch(path.basename(value), aName);
            const bScore = fuzzySearch(path.basename(value), bName);
            return aScore !== bScore
              ? aScore - bScore
              : aType === bType
                ? aName.localeCompare(bName)
                : aType === vscode.FileType.Directory
                  ? -1
                  : 1;
          });
        }

        const args = entries.map(([name, type]) => {
          let label = path.join(dir, name);
          let namestring = path.join(fullDir, name);
          if (type === vscode.FileType.Directory) {
            label += path.sep;
            namestring += path.sep;
          }
          const { mode, size, date, isDir } = fileDescription(namestring);
          return {
            label: label,
            namestring: namestring,
            labelWidth: uiFont?.layout(label).advanceWidth,
            mode: mode,
            modeWidth: uiFont?.layout(mode).advanceWidth,
            size: size,
            sizeWidth: uiFont?.layout(size).advanceWidth,
            date: date,
            isDir: isDir,
          };
        });
        if (isDir) {
          const dot = "." + path.sep;
          const dotdot = ".." + path.sep;
          const {
            mode: mode1,
            size: size1,
            date: date1,
            isDir: isDir1,
          } = fileDescription(fullDir + dot);
          const {
            mode: mode2,
            size: size2,
            date: date2,
            isDir: isDir2,
          } = fileDescription(fullDir + dotdot);
          args.unshift({
            label: dir + dotdot,
            namestring: fullDir + dotdot,
            labelWidth: uiFont?.layout(dir + dotdot).advanceWidth,
            mode: mode1,
            modeWidth: uiFont?.layout(mode1).advanceWidth,
            size: size1,
            sizeWidth: uiFont?.layout(size1).advanceWidth,
            date: date1,
            isDir: isDir1,
          });
          args.unshift({
            label: dir + dot,
            namestring: fullDir + dot,
            labelWidth: uiFont?.layout(dir + dot).advanceWidth,
            mode: mode2,
            modeWidth: uiFont?.layout(mode2).advanceWidth,
            size: size2,
            sizeWidth: uiFont?.layout(size2).advanceWidth,
            date: date2,
            isDir: isDir2,
          });
        }
        const maxLabelWidth = Math.max(...args.map((a) => a.labelWidth ?? 0));
        const maxModeWidth = Math.max(...args.map((a) => a.modeWidth ?? 0));
        const maxSizeWidth = Math.max(...args.map((a) => a.sizeWidth ?? 0));
        const items = args.map(
          ({ label, namestring, labelWidth, mode, modeWidth, size, sizeWidth, date, isDir }) =>
            new File(
              label,
              namestring,
              Math.ceil((maxLabelWidth - (labelWidth ?? 0)) / ((upm ?? 0) / 4)),
              isDir,
              mode +
                "\u2005".repeat(Math.ceil((maxModeWidth - (modeWidth ?? 0)) / ((upm ?? 0) / 4))) +
                "\t" +
                size +
                "\u2005".repeat(Math.ceil((maxSizeWidth - (sizeWidth ?? 0)) / ((upm ?? 0) / 4))) +
                "\t" +
                date,
            ),
        );
        quickPick.items = items;
      });
    };
    quickPick.onDidChangeValue(refresh);
    quickPick.onDidAccept(() => {
      const selected = quickPick.selectedItems[0];
      if (selected) {
        if (selected.labelText.endsWith(".." + path.sep)) {
          quickPick.value = path.normalize(selected.labelText);
          refresh();
        } else if (selected.labelText.endsWith("." + path.sep)) {
          openFolder(selected.namestring);
          quickPick.dispose();
        } else if (selected.labelText.endsWith(path.sep)) {
          quickPick.value = path.normalize(selected.labelText);
          refresh();
        } else {
          vscode.window.showTextDocument(selected.resourceUri!);
          quickPick.dispose();
        }
      } else {
        const value = quickPick.value;
        const isDir = value === "" || value.endsWith(path.sep);
        const fullPath = expandTilde(
          path.isAbsolute(expandTilde(value)) ? value : path.join(currentDir, value),
        );
        if (isDir) {
          vscode.workspace.fs.createDirectory(vscode.Uri.file(fullPath)).then(() => {
            openFolder(fullPath);
          });
        } else {
          const uri = vscode.Uri.file(fullPath).with({ scheme: "untitled" });
          vscode.window.showTextDocument(uri);
        }
        quickPick.dispose();
      }
    });
    quickPick.onDidHide(() => quickPick.dispose());
    quickPick.placeholder = "Enter a path";
    quickPick.show();
    quickPick.value = collapseTilde(currentDir);
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {}
