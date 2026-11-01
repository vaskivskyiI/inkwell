// Writes <out>/doc.json and <out>/files/<n> for a OneNote file. A failure is written to <out>/error.txt: this runs under
// WASI, where the way back to the host is narrow. Positions stay in OneNote's units (half inches; ink in 0.01 mm).
use onenote_parser::{FileSystem, Parser};
use onenote_parser::contents::{Content, EmbeddedFile, EmbeddedObject, Image, Ink, OutlineElement, OutlineItem, RichText, Table};
use onenote_parser::page::{Page, PageContent};
use onenote_parser::property::common::ColorRef;
use onenote_parser::section::{Section, SectionEntry};
use serde_json::{Value, json};
use std::cell::Cell;
use std::fs;
use std::io::{Error, Read};
use typed_path::{TypedPath, TypedPathBuf};

// The parser's own file system does not build for WASI.
#[derive(Clone, Copy)]
struct WasiFs;

fn os(path: TypedPath) -> String {
    path.to_string_lossy().into_owned()
}

impl FileSystem for WasiFs {
    fn is_directory(&self, path: TypedPath) -> Result<bool, Error> {
        Ok(fs::metadata(os(path))?.is_dir())
    }
    fn read_dir(&self, path: TypedPath) -> Result<Vec<TypedPathBuf>, Error> {
        let mut out = Vec::new();
        for e in fs::read_dir(os(path))? {
            out.push(TypedPathBuf::from(e?.path().to_string_lossy().as_ref()));
        }
        out.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
        Ok(out)
    }
    fn read_file(&self, path: TypedPath) -> Result<Vec<u8>, Error> {
        fs::read(os(path))
    }
    fn write_file(&self, path: TypedPath, data: &[u8]) -> Result<(), Error> {
        fs::write(os(path), data)
    }
    fn stream_to_file(&self, path: TypedPath, reader: &mut dyn Read) -> Result<(), Error> {
        std::io::copy(reader, &mut fs::File::create(os(path))?).map(|_| ())
    }
    fn make_dir(&self, path: TypedPath) -> Result<(), Error> {
        fs::create_dir_all(os(path))
    }
    fn canonicalize(&self, path: TypedPath) -> Result<TypedPathBuf, Error> {
        Ok(path.to_path_buf())
    }
    fn exists(&self, path: TypedPath) -> Result<bool, Error> {
        Ok(fs::metadata(os(path)).is_ok())
    }
    fn is_windows(&self) -> bool {
        false
    }
}

struct Ctx {
    dir: String,
    next: Cell<u32>,
}

impl Ctx {
    fn save(&self, mut r: Box<dyn Read>) -> Option<u32> {
        let mut data = Vec::new();
        r.read_to_end(&mut data).ok()?;
        if data.is_empty() {
            return None;
        }
        let n = self.next.get();
        self.next.set(n + 1);
        fs::write(format!("{}/files/{}", self.dir, n), data).ok()?;
        Some(n)
    }
}

fn color(c: Option<ColorRef>) -> Value {
    match c {
        Some(ColorRef::Manual { r, g, b }) => json!(format!("#{r:02x}{g:02x}{b:02x}")),
        _ => Value::Null,
    }
}

fn ink(i: &Ink) -> Value {
    let strokes: Vec<Value> = i.ink_strokes().iter().map(|s| {
        json!({
            "p": s.absolute_path().iter().flat_map(|p| [p.x(), p.y()]).collect::<Vec<f32>>(),
            "w": s.width(), "h": s.height(), "color": s.color(), "alpha": s.transparency(),
        })
    }).collect();
    json!({
        "type": "ink", "x": i.offset_horizontal(), "y": i.offset_vertical(), "strokes": strokes,
        "groups": i.child_groups().iter().map(ink).collect::<Vec<_>>(),
        "box": i.bounding_box().map(|b| [b.x(), b.y(), b.width(), b.height()]),
    })
}

fn image(i: &Image, c: &Ctx) -> Value {
    json!({
        "type": "image", "file": i.read().and_then(|r| c.save(r)), "ext": i.extension(), "alt": i.alt_text(), "ocr": i.text(),
        "w": i.layout_max_width().or(i.picture_width()), "h": i.layout_max_height().or(i.picture_height()),
        "x": i.offset_horizontal(), "y": i.offset_vertical(), "background": i.is_background(), "href": i.hyperlink_url(), "name": i.image_filename(),
    })
}

fn file(f: &EmbeddedFile, c: &Ctx) -> Value {
    json!({ "type": "file", "file": c.save(f.read()), "name": f.filename(), "x": f.offset_horizontal(), "y": f.offset_vertical() })
}

// Links arrive as a hidden `\u{fddf}HYPERLINK "url"` run before the visible text.
fn clean(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    let marker = "\u{fddf}HYPERLINK \"";
    while let Some(i) = rest.find(marker) {
        out.push_str(&rest[..i]);
        let after = &rest[i + marker.len()..];
        rest = after.find('"').map_or("", |end| &after[end + 1..]);
    }
    out.push_str(rest);
    out.chars().filter(|c| *c != '\u{fddf}').collect()
}

fn rich(t: &RichText, extra: &mut Vec<Value>) -> Value {
    let text: Vec<u16> = t.text().encode_utf16().collect();
    let links = t.hyperlinks();
    let styles = t.text_run_formatting();
    let mut ends: Vec<usize> = t.text_run_indices().iter().map(|i| *i as usize).collect();
    ends.push(text.len());
    let mut start = 0;
    let mut runs = Vec::new();
    for (n, end) in ends.iter().enumerate() {
        let end = (*end).min(text.len());
        if end <= start {
            continue;
        }
        let s = String::from_utf16_lossy(&text[start..end]);
        let style = styles.get(n);
        if !style.is_some_and(|x| x.hidden()) {
            let body = clean(&s);
            if !body.is_empty() {
                let href = links.iter().find(|l| (l.start() as usize) < end && (l.end() as usize) > start).map(|l| l.target().to_string());
                runs.push(match style {
                    Some(x) => json!({
                        "text": body, "bold": x.bold(), "italic": x.italic(), "underline": x.underline(), "strike": x.strikethrough(),
                        "sup": x.superscript(), "sub": x.subscript(), "highlight": color(x.highlight()), "font": x.font(), "href": href,
                    }),
                    None => json!({ "text": body, "href": href }),
                });
            }
        }
        start = end;
    }
    for o in t.embedded_objects() {
        if let EmbeddedObject::Ink(i) = o {
            extra.push(ink(i.ink()));
        }
    }
    let p = t.paragraph_style();
    let tags: Vec<Value> = t.note_tags().iter().map(|n| {
        json!({ "label": n.definition().map(|d| d.label()), "shape": n.definition().map(|d| format!("{:?}", d.shape())), "done": n.item_status().completed(), "task": n.item_status().task_tag() })
    }).collect();
    json!({ "type": "text", "style": p.style_id(), "size": p.font_size(), "bold": p.bold(), "runs": runs, "tags": tags })
}

fn content(x: &Content, c: &Ctx) -> Vec<Value> {
    match x {
        Content::RichText(t) => {
            let mut extra = Vec::new();
            let mut out = vec![rich(t, &mut extra)];
            out.append(&mut extra);
            out
        }
        Content::Table(t) => vec![table(t, c)],
        Content::Image(i) => vec![image(i, c)],
        Content::EmbeddedFile(f) => vec![file(f, c)],
        Content::Ink(i) => vec![ink(i)],
        _ => vec![json!({ "type": "unknown" })],
    }
}

fn table(t: &Table, c: &Ctx) -> Value {
    let rows: Vec<Value> = t.contents().iter().map(|r| {
        json!(r.contents().iter().map(|cell| {
            json!(cell.contents().iter().map(|e| element(e, c)).collect::<Vec<_>>())
        }).collect::<Vec<_>>())
    }).collect();
    json!({ "type": "table", "rows": rows })
}

fn element(e: &OutlineElement, c: &Ctx) -> Value {
    let list = e.list_contents().first().map(|l| json!({ "format": l.list_format().iter().collect::<String>(), "font": l.list_font() }));
    json!({
        "type": "element", "list": list,
        "contents": e.contents().iter().flat_map(|x| content(x, c)).collect::<Vec<_>>(),
        "children": e.children().iter().map(|i| item(i, c)).collect::<Vec<_>>(),
    })
}

fn item(i: &OutlineItem, c: &Ctx) -> Value {
    match i {
        OutlineItem::Element(e) => element(e, c),
        OutlineItem::Group(g) => json!({ "type": "group", "items": g.outlines().iter().map(|x| item(x, c)).collect::<Vec<_>>() }),
    }
}

fn page(p: &Page, c: &Ctx) -> Value {
    let contents: Vec<Value> = p.contents().iter().map(|x| match x {
        PageContent::Outline(o) => json!({
            "type": "outline", "x": o.offset_horizontal(), "y": o.offset_vertical(), "w": o.layout_max_width(),
            "items": o.items().iter().map(|i| item(i, c)).collect::<Vec<_>>(),
        }),
        PageContent::Image(i) => image(i, c),
        PageContent::EmbeddedFile(f) => file(f, c),
        PageContent::Ink(i) => ink(i),
        _ => json!({ "type": "unknown" }),
    }).collect();
    json!({
        "id": p.link_target_id(), "title": p.title_text(), "level": p.level(), "height": p.height(),
        "created": p.created_time().unix_timestamp() * 1000, "updated": p.updated_time().unix_timestamp() * 1000,
        "recognized": p.ink_recognition().map(|r| r.text()), "contents": contents,
    })
}

fn section(s: &Section, c: &Ctx) -> Value {
    let pages: Vec<Value> = s.page_series().iter().flat_map(|ps| ps.pages()).map(|p| page(p, c)).collect();
    json!({ "type": "section", "name": s.display_name(), "pages": pages })
}

fn entry(e: &SectionEntry, c: &Ctx) -> Value {
    match e {
        SectionEntry::Section(s) => section(s, c),
        SectionEntry::SectionGroup(g) => json!({ "type": "group", "name": g.display_name(), "entries": g.entries().iter().map(|x| entry(x, c)).collect::<Vec<_>>() }),
    }
}

fn run(input: &str, c: &Ctx) -> Result<Value, Box<dyn std::error::Error>> {
    let path = TypedPath::derive(input);
    let parser = Parser::new_with_fs(WasiFs);
    let lower = input.to_lowercase();
    if lower.ends_with(".one") {
        return Ok(json!({ "entries": [section(&parser.parse_section(path)?, c)], "warnings": [] }));
    }
    let notebook = if lower.ends_with(".onepkg") { parser.parse_package(path)? } else { parser.parse_notebook(path)? };
    let warnings: Vec<&str> = notebook.report().warnings().iter().map(|w| w.message()).collect();
    Ok(json!({ "entries": notebook.entries().iter().map(|e| entry(e, c)).collect::<Vec<_>>(), "warnings": warnings }))
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let c = Ctx { dir: args[2].clone(), next: Cell::new(0) };
    fs::create_dir_all(format!("{}/files", c.dir)).unwrap();
    match run(&args[1], &c) {
        Ok(v) => fs::write(format!("{}/doc.json", c.dir), v.to_string()).unwrap(),
        Err(e) => fs::write(format!("{}/error.txt", c.dir), e.to_string()).unwrap(),
    }
}
