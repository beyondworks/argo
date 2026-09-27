//! macOS resolves notification sounds by name through the user's Library/Sounds.
//! Use the same PCM WAV bytes as the in-app preview; leave playback to macOS.
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

pub fn asset(name: &str) -> Option<(&'static str, &'static [u8])> {
    match name {
        "wood-knock" => Some((
            "argo-messenger-wood-knock.wav",
            include_bytes!("../../public/sounds/wood-knock.wav"),
        )),
        "wood-knock-double" => Some((
            "argo-messenger-wood-knock-double.wav",
            include_bytes!("../../public/sounds/wood-knock-double.wav"),
        )),
        "wood-marimba" => Some((
            "argo-messenger-wood-marimba.wav",
            include_bytes!("../../public/sounds/wood-marimba.wav"),
        )),
        "seatbelt-single" => Some((
            "argo-messenger-seatbelt-single.wav",
            include_bytes!("../../public/sounds/seatbelt-single.wav"),
        )),
        "seatbelt-hilo" => Some((
            "argo-messenger-seatbelt-hilo.wav",
            include_bytes!("../../public/sounds/seatbelt-hilo.wav"),
        )),
        _ => None,
    }
}

pub fn register(directory: &Path, filename: &str, bytes: &[u8]) -> io::Result<()> {
    let path = directory.join(filename);
    if fs::read(&path).is_ok_and(|existing| existing == bytes) {
        return Ok(());
    }
    fs::create_dir_all(directory)?;
    // Publish only a complete file, even when both notification producers arrive together.
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let temporary = directory.join(format!(
        ".{filename}-{}-{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    let result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, &path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_choices_use_preview_wav_and_unknown_is_silent() {
        for name in [
            "wood-knock",
            "wood-knock-double",
            "wood-marimba",
            "seatbelt-single",
            "seatbelt-hilo",
        ] {
            let (filename, bytes) = asset(name).unwrap();
            assert_eq!(filename, format!("argo-messenger-{name}.wav"));
            assert_eq!(&bytes[..4], b"RIFF");
            assert_eq!(&bytes[8..12], b"WAVE");
        }
        assert!(asset("none").is_none());
        assert!(asset("../../elsewhere").is_none());
    }

    #[test]
    fn simultaneous_registration_publishes_complete_files() {
        let directory = std::env::temp_dir().join(format!("argo-sound-concurrent-{}", std::process::id()));
        let (filename, bytes) = asset("wood-knock").unwrap();
        std::thread::scope(|scope| {
            for _ in 0..8 {
                let directory = &directory;
                scope.spawn(move || {
                    register(directory, filename, bytes).unwrap();
                    assert_eq!(fs::read(directory.join(filename)).unwrap(), bytes);
                });
            }
        });
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn registration_creates_repairs_and_preserves_identical_files() {
        let directory =
            std::env::temp_dir().join(format!("argo-sound-test-{}", std::process::id()));
        let (filename, bytes) = asset("wood-knock").unwrap();
        register(&directory, filename, bytes).unwrap();
        let path = directory.join(filename);
        assert_eq!(fs::read(&path).unwrap(), bytes);
        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        register(&directory, filename, bytes).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), modified);
        fs::write(&path, b"truncated").unwrap();
        register(&directory, filename, bytes).unwrap();
        assert_eq!(fs::read(&path).unwrap(), bytes);
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        assert!(register(&path, filename, bytes).is_err());
        fs::remove_dir_all(directory).unwrap();
    }
}
