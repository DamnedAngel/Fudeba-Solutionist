'use strict';
// Text-splicing edits of MSBuild project files and their .filters companions. Nothing is re-serialised:
// untouched bytes (formatting, comments, BOM, line endings) stay exactly as the user wrote them.
const fs = require('fs');
const crypto = require('crypto');
const { parseXml, kids, kid, attr, value, eq, encode, encodeAttr } = require('./xml');
const { evalCondition } = require('./props');
const { normInclude } = require('./project');

const eolOf = (t) => (t.includes('\r\n') ? '\r\n' : '\n');
const lineStart = (t, i) => t.lastIndexOf('\n', i - 1) + 1;
const blankBefore = (t, i) => /^[ \t]*$/.test(t.slice(lineStart(t, i), i));
const indentOf = (t, node) => (blankBefore(t, node.start) ? t.slice(lineStart(t, node.start), node.start) : '');
const projectRoot = (t) => kid(parseXml(t), 'Project');

function indentBlock(xml, indent, eol) {
  return xml.split('\n').map((l, i) => (i === 0 ? l : indent + l)).join(eol);
}

function removeNode(t, node) {
  let s = node.start, e = node.end;
  if (blankBefore(t, s)) {
    const m = /^[ \t]*\r?\n/.exec(t.slice(e));
    if (m) { s = lineStart(t, s); e += m[0].length; }
  }
  return t.slice(0, s) + t.slice(e);
}

/** Adds `xml` as the last child of `parent`, indented like its siblings. */
function appendChild(t, parent, xml) {
  const eol = eolOf(t);
  const ind = indentOf(t, parent);
  const childIndent = parent.children.length ? indentOf(t, parent.children[0]) : ind + '  ';
  const block = childIndent + indentBlock(xml, childIndent, eol);
  if (parent.selfClosing) {
    const open = t.slice(parent.start, parent.end).replace(/\s*\/>$/, '>');
    return t.slice(0, parent.start) + open + eol + block + eol + ind + `</${parent.name}>` + t.slice(parent.end);
  }
  if (blankBefore(t, parent.closeStart)) {
    const at = lineStart(t, parent.closeStart);
    return t.slice(0, at) + block + eol + t.slice(at);
  }
  return t.slice(0, parent.closeStart) + eol + block + eol + ind + t.slice(parent.closeStart);
}

/** Inserts `xml` as a sibling right before `node`. */
function insertBefore(t, node, xml) {
  const eol = eolOf(t);
  const ind = indentOf(t, node);
  const at = blankBefore(t, node.start) ? lineStart(t, node.start) : node.start;
  return t.slice(0, at) + ind + indentBlock(xml, ind, eol) + eol + t.slice(at);
}

function setInnerText(t, node, val) {
  if (node.selfClosing) return t.slice(0, node.start) + `<${node.name}>${encode(val)}</${node.name}>` + t.slice(node.end);
  return t.slice(0, node.openEnd) + encode(val) + t.slice(node.closeStart);
}

const read = (f) => fs.readFileSync(f, 'utf8');
const write = (f, t) => fs.writeFileSync(f, t, 'utf8');

// ---- Build actions (properties) -----------------------------------------------------------------

/**
 * Sets (or adds) a property in the configuration-specific PropertyGroup that applies to `pd`'s active
 * configuration (e.g. NMakeBuildCommandLine for Debug|Win32). `pd` is a loaded ProjectData.
 */
function setConfigProperty(pd, name, val) {
  const t = read(pd.file);
  const root = projectRoot(t);
  const groups = kids(root, 'PropertyGroup').filter((g) => attr(g, 'Condition') && !attr(g, 'Label') && evalCondition(attr(g, 'Condition'), pd.props, pd.dir));
  if (!groups.length) throw new Error(`No ${pd.config}|${pd.platform} PropertyGroup found in ${pd.file}; edit the project file by hand.`);
  for (const g of [...groups].reverse()) {
    const c = kids(g, name)[0];
    if (c) { write(pd.file, setInnerText(t, c, val)); return; }
  }
  write(pd.file, appendChild(t, groups[groups.length - 1], `<${name}>${encode(val)}</${name}>`));
}

/** Raw (unexpanded) value of a property in the group that applies to the active configuration. */
function getRawConfigProperty(pd, name) {
  const root = projectRoot(read(pd.file));
  let found = '';
  for (const g of kids(root, 'PropertyGroup')) {
    if (!attr(g, 'Condition') || attr(g, 'Label') || !evalCondition(attr(g, 'Condition'), pd.props, pd.dir)) continue;
    const c = kids(g, name)[0];
    if (c) found = value(c);
  }
  return found;
}

// ---- Project references -------------------------------------------------------------------------

function addProjectReference(file, includePath, guid) {
  const t = read(file);
  const root = projectRoot(t);
  const g = guid ? (guid.startsWith('{') ? guid : `{${guid}}`) : '';
  const inner = g
    ? `<ProjectReference Include="${encodeAttr(includePath)}">\n  <Project>${g}</Project>\n</ProjectReference>`
    : `<ProjectReference Include="${encodeAttr(includePath)}" />`;
  const group = kids(root, 'ItemGroup').find((g) => kids(g, 'ProjectReference').length);
  if (group) { write(file, appendChild(t, group, inner)); return; }
  const imp = kids(root, 'Import').reverse().find((i) => /targets/i.test(attr(i, 'Project') || ''));
  const block = `<ItemGroup>\n  ${inner.replace(/\n/g, '\n  ')}\n</ItemGroup>`;
  write(file, imp ? insertBefore(t, imp, block) : appendChild(t, root, block));
}

function removeProjectReference(file, absPathOrInclude, matches) {
  let t = read(file);
  for (;;) {
    const root = projectRoot(t);
    let victim = null, group = null;
    for (const g of kids(root, 'ItemGroup')) {
      for (const c of kids(g, 'ProjectReference')) if (matches(attr(c, 'Include') || '', c)) { victim = c; group = g; break; }
      if (victim) break;
    }
    if (!victim) break;
    t = group.children.length === 1 ? removeNode(t, group) : removeNode(t, victim);
  }
  write(file, t);
}

// ---- Filters ------------------------------------------------------------------------------------

const FILTERS_SKELETON = (eol) => `﻿<?xml version="1.0" encoding="utf-8"?>${eol}<Project ToolsVersion="4.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">${eol}</Project>`;
const guidLower = () => `{${crypto.randomUUID()}}`;

function ensureFiltersFile(projectFile) {
  const ff = `${projectFile}.filters`;
  if (!fs.existsSync(ff)) write(ff, FILTERS_SKELETON('\r\n'));
  return ff;
}

function definedFilters(root) {
  const set = new Map();
  for (const g of kids(root, 'ItemGroup')) for (const c of kids(g, 'Filter')) set.set((attr(c, 'Include') || '').toLowerCase(), c);
  return set;
}

/** Adds the Filter definition for `name` and every ancestor that does not exist yet. */
function addFilterDefs(ff, name) {
  const parts = name.split('\\');
  for (let i = 1; i <= parts.length; i++) {
    const full = parts.slice(0, i).join('\\');
    const t = read(ff);
    const root = projectRoot(t);
    if (definedFilters(root).has(full.toLowerCase())) continue;
    const xml = `<Filter Include="${encodeAttr(full)}">\n  <UniqueIdentifier>${guidLower()}</UniqueIdentifier>\n</Filter>`;
    const group = kids(root, 'ItemGroup').find((g) => kids(g, 'Filter').length);
    write(ff, group ? appendChild(t, group, xml) : appendChild(t, root, `<ItemGroup>\n  ${xml.replace(/\n/g, '\n  ')}\n</ItemGroup>`));
  }
}

function addFilter(projectFile, name) { addFilterDefs(ensureFiltersFile(projectFile), name); }

function itemEntries(root) {
  const out = [];
  for (const g of kids(root, 'ItemGroup')) for (const c of g.children) {
    const inc = attr(c, 'Include');
    if (inc !== undefined && !eq(c.name, 'Filter')) out.push({ node: c, group: g, include: inc });
  }
  return out;
}

/** Puts an item (already in the project) into `filter`, or takes it out of all filters when null. */
function setItemFilter(projectFile, type, include, filter) {
  const ff = filter || fs.existsSync(`${projectFile}.filters`) ? ensureFiltersFile(projectFile) : null;
  if (!ff) return; // no filters file and nothing to put into one
  if (filter) addFilterDefs(ff, filter);
  const t = read(ff);
  const root = projectRoot(t);
  const entry = itemEntries(root).find((e) => normInclude(e.include) === normInclude(include));
  if (entry) {
    const f = kid(entry.node, 'Filter');
    if (!filter) {
      if (!f) return;
      write(ff, entry.node.children.length === 1 ? (entry.group.children.length === 1 ? removeNode(t, entry.group) : removeNode(t, entry.node)) : removeNode(t, f));
    } else if (f) write(ff, setInnerText(t, f, filter));
    else write(ff, appendChild(t, entry.node, `<Filter>${encode(filter)}</Filter>`));
    return;
  }
  if (!filter) return;
  const xml = `<${type} Include="${encodeAttr(include)}">\n  <Filter>${encode(filter)}</Filter>\n</${type}>`;
  const group = kids(root, 'ItemGroup').find((g) => kids(g, type).length);
  write(ff, group ? appendChild(t, group, xml) : appendChild(t, root, `<ItemGroup>\n  ${xml.replace(/\n/g, '\n  ')}\n</ItemGroup>`));
}

/** Renames a filter and everything below it (definitions and item assignments). */
function renameFilter(projectFile, oldName, newName) {
  const ff = `${projectFile}.filters`;
  let t = read(ff);
  for (;;) {
    const root = projectRoot(t);
    const lo = oldName.toLowerCase();
    const hit = (s) => s.toLowerCase() === lo || s.toLowerCase().startsWith(lo + '\\');
    const swap = (s) => newName + s.slice(oldName.length);
    let next = null;
    for (const g of kids(root, 'ItemGroup')) for (const c of g.children) {
      if (eq(c.name, 'Filter') && attr(c, 'Include') !== undefined) {
        const inc = attr(c, 'Include');
        if (hit(inc) && inc !== swap(inc)) { next = [c, 'attr', swap(inc)]; break; }
      } else {
        const f = kid(c, 'Filter');
        if (f && hit(value(f)) && value(f) !== swap(value(f))) { next = [f, 'text', swap(value(f))]; break; }
      }
      if (next) break;
    }
    if (!next) break;
    const [node, how, to] = next;
    if (how === 'text') t = setInnerText(t, node, to);
    else {
      const open = t.slice(node.start, node.openEnd);
      t = t.slice(0, node.start) + open.replace(/Include="[^"]*"/, `Include="${encodeAttr(to)}"`) + t.slice(node.openEnd);
    }
  }
  write(ff, t);
}

/** Removes a filter definition; refuses while anything still lives in it. */
function removeFilter(projectFile, name) {
  const ff = `${projectFile}.filters`;
  const t = read(ff);
  const root = projectRoot(t);
  const lo = name.toLowerCase();
  for (const e of itemEntries(root)) {
    const f = kid(e.node, 'Filter');
    if (f && (value(f).toLowerCase() === lo || value(f).toLowerCase().startsWith(lo + '\\'))) throw new Error(`The filter "${name}" is not empty.`);
  }
  for (const [k] of definedFilters(root)) if (k.startsWith(lo + '\\')) throw new Error(`The filter "${name}" has sub-filters.`);
  const def = definedFilters(root).get(lo);
  if (!def) return;
  write(ff, def.parent.children.length === 1 ? removeNode(t, def.parent) : removeNode(t, def));
}

// ---- Files --------------------------------------------------------------------------------------

function itemTypeFor(file, byExt) {
  const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
  return byExt[ext] || 'None';
}

/** Adds a file to the project (and to `filter` if given). */
function addItem(projectFile, type, include, filter) {
  const t = read(projectFile);
  const root = projectRoot(t);
  const xml = `<${type} Include="${encodeAttr(include)}" />`;
  const group = kids(root, 'ItemGroup').find((g) => !attr(g, 'Label') && !attr(g, 'Condition') && kids(g, type).length);
  if (group) write(projectFile, appendChild(t, group, xml));
  else {
    const imp = kids(root, 'Import').reverse().find((i) => /targets/i.test(attr(i, 'Project') || ''));
    const block = `<ItemGroup>\n  ${xml}\n</ItemGroup>`;
    write(projectFile, imp ? insertBefore(t, imp, block) : appendChild(t, root, block));
  }
  if (filter) setItemFilter(projectFile, type, include, filter);
}

/** Removes every item for `include` from the project and from the filters file. */
function removeItem(projectFile, include) {
  for (const f of [projectFile, `${projectFile}.filters`]) {
    if (!fs.existsSync(f)) continue;
    let t = read(f);
    for (;;) {
      const root = projectRoot(t);
      const e = itemEntries(root).find((x) => normInclude(x.include) === normInclude(include) && !/^(projectconfiguration|projectreference)$/i.test(x.node.name));
      if (!e) break;
      t = e.group.children.length === 1 ? removeNode(t, e.group) : removeNode(t, e.node);
    }
    write(f, t);
  }
}

module.exports = {
  setConfigProperty, getRawConfigProperty, addProjectReference, removeProjectReference,
  addFilter, setItemFilter, renameFilter, removeFilter, addItem, removeItem, itemTypeFor,
  // exported for the solution editor
  appendChild, insertBefore, removeNode, setInnerText, eolOf, read, write, projectRoot, indentOf,
};
