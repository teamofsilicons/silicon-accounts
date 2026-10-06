//! Profile photo inspection: recognizes PNG, JPEG, GIF and WebP by their bytes (never by the
//! declared Content-Type alone) and reads the pixel dimensions from the headers, without
//! decoding the image. Every photo upload goes through it (see [`crate::photo_upload`]).
//!
//! Why: photos are served from our own origin, so only real raster images may be stored (an SVG
//! or HTML body labelled `image/png` must never be served), and absurd canvases
//! ("decompression bombs" that fit in 2 MB) are refused before they reach anyone's browser.

use std::fmt;

/// Largest width or height accepted, in pixels.
pub const MAX_DIMENSION: u32 = 8192;
/// Largest canvas accepted, in pixels (width × height).
pub const MAX_PIXELS: u64 = 50_000_000;

/// The accepted image formats.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ImageKind {
    Png,
    Jpeg,
    Gif,
    Webp,
}

impl ImageKind {
    /// Every accepted format.
    pub const ALL: [ImageKind; 4] = [
        ImageKind::Png,
        ImageKind::Jpeg,
        ImageKind::Webp,
        ImageKind::Gif,
    ];

    /// The media type the photo is stored and served with.
    pub const fn mime(self) -> &'static str {
        match self {
            ImageKind::Png => "image/png",
            ImageKind::Jpeg => "image/jpeg",
            ImageKind::Gif => "image/gif",
            ImageKind::Webp => "image/webp",
        }
    }

    /// The format's name for messages.
    pub const fn name(self) -> &'static str {
        match self {
            ImageKind::Png => "PNG",
            ImageKind::Jpeg => "JPEG",
            ImageKind::Gif => "GIF",
            ImageKind::Webp => "WebP",
        }
    }

    /// Parses a Content-Type value (parameters and case ignored). `image/jpg`, `image/pjpeg`
    /// and `image/x-png` are accepted aliases.
    pub fn from_content_type(content_type: &str) -> Option<ImageKind> {
        let mime = content_type
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        match mime.as_str() {
            "image/png" | "image/x-png" => Some(ImageKind::Png),
            "image/jpeg" | "image/jpg" | "image/pjpeg" => Some(ImageKind::Jpeg),
            "image/gif" => Some(ImageKind::Gif),
            "image/webp" => Some(ImageKind::Webp),
            _ => None,
        }
    }

    /// `image/png, image/jpeg, image/webp or image/gif`.
    pub fn accepted_list() -> &'static str {
        "image/png, image/jpeg, image/webp or image/gif"
    }
}

impl fmt::Display for ImageKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

/// A recognized image.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImageInfo {
    pub kind: ImageKind,
    pub width: u32,
    pub height: u32,
}

/// Why bytes were refused as a profile photo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImageError {
    /// Not a PNG, JPEG, GIF or WebP file. `looks_like` names what it seems to be, if anything.
    Unrecognized { looks_like: Option<&'static str> },
    /// A real image, but not the declared format.
    Mismatch {
        declared: ImageKind,
        actual: ImageKind,
    },
    /// The format's header is truncated or malformed.
    Corrupt { kind: ImageKind, why: &'static str },
    /// Wider/taller than [`MAX_DIMENSION`] or larger than [`MAX_PIXELS`].
    TooLarge {
        kind: ImageKind,
        width: u32,
        height: u32,
    },
}

/// Recognizes the format from the first bytes.
pub fn sniff(bytes: &[u8]) -> Option<ImageKind> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some(ImageKind::Png)
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(ImageKind::Jpeg)
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some(ImageKind::Gif)
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some(ImageKind::Webp)
    } else {
        None
    }
}

/// A best guess at what non-image bytes are, for a precise error message.
fn looks_like(bytes: &[u8]) -> Option<&'static str> {
    let head: Vec<u8> = bytes
        .iter()
        .copied()
        .skip_while(|b| b.is_ascii_whitespace() || *b == 0xEF || *b == 0xBB || *b == 0xBF)
        .take(256)
        .collect();
    let lower = String::from_utf8_lossy(&head).to_ascii_lowercase();
    if lower.starts_with("<svg") || (lower.starts_with("<?xml") && lower.contains("<svg")) {
        Some("an SVG image (vector images are not accepted)")
    } else if lower.starts_with("<!doctype html") || lower.starts_with("<html") {
        Some("an HTML document")
    } else if lower.starts_with('<') {
        Some("XML or HTML text")
    } else if lower.starts_with('{') || lower.starts_with('[') {
        Some("JSON text")
    } else if head.starts_with(b"%PDF") {
        Some("a PDF document")
    } else if head.starts_with(b"BM") {
        Some("a BMP image (not accepted)")
    } else if head.starts_with(&[0x49, 0x49, 0x2A, 0x00])
        || head.starts_with(&[0x4D, 0x4D, 0x00, 0x2A])
    {
        Some("a TIFF image (not accepted)")
    } else if head.len() >= 12 && &head[4..8] == b"ftyp" {
        Some("a HEIC/AVIF image or video (not accepted)")
    } else if head.starts_with(b"--") || lower.starts_with("content-disposition") {
        Some("a multipart form body")
    } else {
        None
    }
}

/// Recognizes the image, checks it is the declared format and reads its dimensions.
pub fn inspect(bytes: &[u8], declared: ImageKind) -> Result<ImageInfo, ImageError> {
    let kind = sniff(bytes).ok_or_else(|| ImageError::Unrecognized {
        looks_like: looks_like(bytes),
    })?;
    if kind != declared {
        return Err(ImageError::Mismatch {
            declared,
            actual: kind,
        });
    }
    let (width, height) = match kind {
        ImageKind::Png => png_dimensions(bytes),
        ImageKind::Jpeg => jpeg_dimensions(bytes),
        ImageKind::Gif => gif_dimensions(bytes),
        ImageKind::Webp => webp_dimensions(bytes),
    }
    .map_err(|why| ImageError::Corrupt { kind, why })?;
    if width == 0 || height == 0 {
        return Err(ImageError::Corrupt {
            kind,
            why: "its header says the image is 0 pixels wide or tall",
        });
    }
    if width > MAX_DIMENSION
        || height > MAX_DIMENSION
        || u64::from(width) * u64::from(height) > MAX_PIXELS
    {
        return Err(ImageError::TooLarge {
            kind,
            width,
            height,
        });
    }
    Ok(ImageInfo {
        kind,
        width,
        height,
    })
}

fn be_u16(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes([*b.get(at)?, *b.get(at + 1)?]))
}

fn le_u16(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes([*b.get(at)?, *b.get(at + 1)?]))
}

fn be_u32(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes([
        *b.get(at)?,
        *b.get(at + 1)?,
        *b.get(at + 2)?,
        *b.get(at + 3)?,
    ]))
}

fn le_u24(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes([
        *b.get(at)?,
        *b.get(at + 1)?,
        *b.get(at + 2)?,
        0,
    ]))
}

/// PNG: the first chunk must be IHDR (width and height are big-endian u32 at bytes 16..24).
fn png_dimensions(b: &[u8]) -> Result<(u32, u32), &'static str> {
    if b.get(12..16) != Some(b"IHDR".as_slice()) {
        return Err("the file ends early or its first chunk is not IHDR");
    }
    match (be_u32(b, 16), be_u32(b, 20)) {
        (Some(w), Some(h)) => Ok((w, h)),
        _ => Err("the file ends inside the IHDR header"),
    }
}

/// GIF: logical screen width and height are little-endian u16 at bytes 6..10.
fn gif_dimensions(b: &[u8]) -> Result<(u32, u32), &'static str> {
    match (le_u16(b, 6), le_u16(b, 8)) {
        (Some(w), Some(h)) => Ok((u32::from(w), u32::from(h))),
        _ => Err("the file ends inside the GIF header"),
    }
}

/// WebP: the first chunk after `RIFF....WEBP` is `VP8 ` (lossy), `VP8L` (lossless) or `VP8X`
/// (extended, with the canvas size).
fn webp_dimensions(b: &[u8]) -> Result<(u32, u32), &'static str> {
    let truncated = "the file ends inside the WebP header";
    match b.get(12..16) {
        Some(b"VP8 ") => {
            if b.get(23..26) != Some([0x9d, 0x01, 0x2a].as_slice()) {
                return Err("the VP8 frame has no start code");
            }
            match (le_u16(b, 26), le_u16(b, 28)) {
                (Some(w), Some(h)) => Ok((u32::from(w & 0x3fff), u32::from(h & 0x3fff))),
                _ => Err(truncated),
            }
        }
        Some(b"VP8L") => {
            if b.get(20) != Some(&0x2f) {
                return Err("the VP8L chunk has no signature byte");
            }
            let bits = match (b.get(21), b.get(22), b.get(23), b.get(24)) {
                (Some(&a), Some(&c), Some(&d), Some(&e)) => u32::from_le_bytes([a, c, d, e]),
                _ => return Err(truncated),
            };
            Ok(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1))
        }
        Some(b"VP8X") => match (le_u24(b, 24), le_u24(b, 27)) {
            (Some(w), Some(h)) => Ok((w + 1, h + 1)),
            _ => Err(truncated),
        },
        Some(_) => Err("its first chunk is not VP8, VP8L or VP8X"),
        None => Err(truncated),
    }
}

/// JPEG: walks the marker segments after SOI until a start-of-frame (SOFn) segment, whose
/// payload holds precision, height and width.
fn jpeg_dimensions(b: &[u8]) -> Result<(u32, u32), &'static str> {
    let mut i = 2;
    loop {
        if i >= b.len() {
            return Err("the file ends before its frame header (SOF)");
        }
        if b[i] != 0xFF {
            return Err("a marker segment is malformed");
        }
        while i < b.len() && b[i] == 0xFF {
            i += 1;
        }
        let Some(&marker) = b.get(i) else {
            return Err("the file ends before its frame header (SOF)");
        };
        i += 1;
        match marker {
            // Markers without a length field.
            0x01 | 0xD0..=0xD8 => continue,
            0xD9 => return Err("the image ends (EOI) before its frame header (SOF)"),
            0xDA => return Err("image data (SOS) starts before the frame header (SOF)"),
            _ => {
                let Some(len) = be_u16(b, i) else {
                    return Err("the file ends inside a marker segment");
                };
                let len = usize::from(len);
                if len < 2 {
                    return Err("a marker segment has an invalid length");
                }
                if matches!(marker, 0xC0..=0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF) {
                    return match (be_u16(b, i + 3), be_u16(b, i + 5)) {
                        (Some(h), Some(w)) => Ok((u32::from(w), u32::from(h))),
                        _ => Err("the file ends inside the frame header (SOF)"),
                    };
                }
                i += len;
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod samples {
    //! Minimal well-formed headers for each format (enough for [`super::inspect`]).

    /// A 1×1 PNG (signature, IHDR, IDAT, IEND).
    pub fn png(width: u32, height: u32) -> Vec<u8> {
        let mut v = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        v.extend_from_slice(&13u32.to_be_bytes());
        v.extend_from_slice(b"IHDR");
        v.extend_from_slice(&width.to_be_bytes());
        v.extend_from_slice(&height.to_be_bytes());
        v.extend_from_slice(&[8, 6, 0, 0, 0]);
        v.extend_from_slice(&[0x1F, 0x15, 0xC4, 0x89]);
        v.extend_from_slice(&[
            0, 0, 0, 0x0D, b'I', b'D', b'A', b'T', 0x78, 0xDA, 0x63, 0xFC, 0xCF, 0xC0, 0xF0, 0x1F,
            0x00, 0x05, 0x05, 0x02, 0x01, 0xA5, 0xD6, 0xD2, 0xD3,
        ]);
        v.extend_from_slice(&[0, 0, 0, 0, b'I', b'E', b'N', b'D', 0xAE, 0x42, 0x60, 0x82]);
        v
    }

    /// A JPEG with an APP0 (JFIF) segment, then SOF0 with the given size, then SOS and EOI.
    pub fn jpeg(width: u16, height: u16) -> Vec<u8> {
        let mut v = vec![0xFF, 0xD8];
        v.extend_from_slice(&[0xFF, 0xE0, 0x00, 0x10]);
        v.extend_from_slice(b"JFIF\0");
        v.extend_from_slice(&[0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
        v.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x11, 0x08]);
        v.extend_from_slice(&height.to_be_bytes());
        v.extend_from_slice(&width.to_be_bytes());
        v.extend_from_slice(&[0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
        v.extend_from_slice(&[0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00]);
        v.extend_from_slice(&[0x12, 0x34, 0xFF, 0xD9]);
        v
    }

    /// A GIF89a header with the given logical screen size, then a trailer.
    pub fn gif(width: u16, height: u16) -> Vec<u8> {
        let mut v = b"GIF89a".to_vec();
        v.extend_from_slice(&width.to_le_bytes());
        v.extend_from_slice(&height.to_le_bytes());
        v.extend_from_slice(&[0x00, 0x00, 0x00, 0x3B]);
        v
    }

    /// A lossless WebP (VP8L) with the given size.
    pub fn webp(width: u32, height: u32) -> Vec<u8> {
        let bits: u32 = (width - 1) | ((height - 1) << 14);
        let mut chunk = vec![0x2f];
        chunk.extend_from_slice(&bits.to_le_bytes());
        chunk.extend_from_slice(&[0, 0, 0]);
        let mut v = b"RIFF".to_vec();
        v.extend_from_slice(&((4 + 8 + chunk.len()) as u32).to_le_bytes());
        v.extend_from_slice(b"WEBP");
        v.extend_from_slice(b"VP8L");
        v.extend_from_slice(&(chunk.len() as u32).to_le_bytes());
        v.extend_from_slice(&chunk);
        v
    }
}

#[cfg(test)]
mod tests {
    use super::samples::*;
    use super::*;

    #[test]
    fn content_types() {
        assert_eq!(
            ImageKind::from_content_type("image/PNG; charset=binary"),
            Some(ImageKind::Png)
        );
        assert_eq!(
            ImageKind::from_content_type("image/jpg"),
            Some(ImageKind::Jpeg)
        );
        assert_eq!(ImageKind::from_content_type("image/svg+xml"), None);
        assert_eq!(ImageKind::from_content_type(""), None);
    }

    #[test]
    fn recognizes_each_format_and_reads_dimensions() {
        let png = inspect(&png(64, 32), ImageKind::Png).expect("png");
        assert_eq!((png.width, png.height), (64, 32));
        let jpeg = inspect(&jpeg(640, 480), ImageKind::Jpeg).expect("jpeg");
        assert_eq!((jpeg.width, jpeg.height), (640, 480));
        let gif = inspect(&gif(10, 20), ImageKind::Gif).expect("gif");
        assert_eq!((gif.width, gif.height), (10, 20));
        let webp = inspect(&webp(300, 200), ImageKind::Webp).expect("webp");
        assert_eq!((webp.width, webp.height), (300, 200));
    }

    #[test]
    fn webp_lossy_and_extended() {
        // VP8 (lossy): frame tag, start code, 14-bit width/height.
        let mut lossy = b"RIFF\0\0\0\0WEBPVP8 \0\0\0\0".to_vec();
        lossy.extend_from_slice(&[0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a]);
        lossy.extend_from_slice(&120u16.to_le_bytes());
        lossy.extend_from_slice(&90u16.to_le_bytes());
        assert_eq!(
            inspect(&lossy, ImageKind::Webp).map(|i| (i.width, i.height)),
            Ok((120, 90))
        );
        // VP8X: 24-bit canvas width-1 / height-1.
        let mut ext = b"RIFF\0\0\0\0WEBPVP8X\x0a\0\0\0".to_vec();
        ext.extend_from_slice(&[0x10, 0, 0, 0]);
        ext.extend_from_slice(&[0xFF, 0x03, 0x00, 0xFF, 0x01, 0x00]);
        assert_eq!(
            inspect(&ext, ImageKind::Webp).map(|i| (i.width, i.height)),
            Ok((1024, 512))
        );
    }

    #[test]
    fn mismatch_unrecognized_and_corrupt() {
        assert_eq!(
            inspect(&jpeg(1, 1), ImageKind::Png),
            Err(ImageError::Mismatch {
                declared: ImageKind::Png,
                actual: ImageKind::Jpeg
            })
        );
        assert_eq!(
            inspect(b"<svg xmlns='http://www.w3.org/2000/svg'/>", ImageKind::Png),
            Err(ImageError::Unrecognized {
                looks_like: Some("an SVG image (vector images are not accepted)")
            })
        );
        assert_eq!(
            inspect(b"<!DOCTYPE html><p>hi", ImageKind::Png),
            Err(ImageError::Unrecognized {
                looks_like: Some("an HTML document")
            })
        );
        assert_eq!(
            inspect(b"\x00\x01\x02", ImageKind::Gif),
            Err(ImageError::Unrecognized { looks_like: None })
        );
        let truncated = &png(1, 1)[..18];
        assert!(matches!(
            inspect(truncated, ImageKind::Png),
            Err(ImageError::Corrupt {
                kind: ImageKind::Png,
                ..
            })
        ));
        // SOS before SOF.
        let bad_jpeg = [0xFF, 0xD8, 0xFF, 0xDA, 0x00, 0x02, 0x00];
        assert!(matches!(
            inspect(&bad_jpeg, ImageKind::Jpeg),
            Err(ImageError::Corrupt {
                kind: ImageKind::Jpeg,
                ..
            })
        ));
        assert!(matches!(
            inspect(&gif(0, 10), ImageKind::Gif),
            Err(ImageError::Corrupt { .. })
        ));
    }

    #[test]
    fn refuses_huge_canvases() {
        assert_eq!(
            inspect(&png(20_000, 20_000), ImageKind::Png),
            Err(ImageError::TooLarge {
                kind: ImageKind::Png,
                width: 20_000,
                height: 20_000
            })
        );
        // 8000 × 8000 is within each side but over 50 megapixels.
        assert!(matches!(
            inspect(&png(8000, 8000), ImageKind::Png),
            Err(ImageError::TooLarge { .. })
        ));
        assert!(inspect(&png(8192, 6000), ImageKind::Png).is_ok());
    }
}
