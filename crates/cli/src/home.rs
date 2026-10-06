//! Where the CLI keeps its state, and how it writes it.
//!
//! State lives in `{home}/.accounts/`. The home is, first match wins:
//! 1. `--home <dir>`
//! 2. `ACCOUNTS_HOME`
//! 3. the directory set with `accounts config home <dir>` (stored as a one-line pointer
//!    file in `{base}/.accounts/home`, where base is `$SILICON_HOME` or `~`)
//! 4. `$SILICON_HOME`
//! 5. `~`
//!
//! Every file is written atomically (temp file + rename) with mode 0600 inside a 0700
//! directory, because the files hold tokens and app secrets.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::error::{CliError, CliResult, EXIT_INVALID};

/// Name of the state directory inside the home.
pub const STATE_DIR: &str = ".accounts";
/// Pointer file written by `accounts config home`.
pub const POINTER_FILE: &str = "home";

/// Where the home came from (shown by `accounts config home` / `config get`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HomeSource {
    Flag,
    AccountsHomeEnv,
    Pointer(PathBuf),
    SiliconHome,
    UserHome,
}

impl HomeSource {
    pub fn describe(&self) -> String {
        match self {
            Self::Flag => "--home".to_owned(),
            Self::AccountsHomeEnv => "ACCOUNTS_HOME".to_owned(),
            Self::Pointer(path) => format!("`accounts config home`, stored in {}", path.display()),
            Self::SiliconHome => "SILICON_HOME".to_owned(),
            Self::UserHome => "default (~)".to_owned(),
        }
    }

    pub fn key(&self) -> &'static str {
        match self {
            Self::Flag => "flag",
            Self::AccountsHomeEnv => "env:ACCOUNTS_HOME",
            Self::Pointer(_) => "config",
            Self::SiliconHome => "env:SILICON_HOME",
            Self::UserHome => "default",
        }
    }
}

/// The resolved home.
#[derive(Debug, Clone)]
pub struct Home {
    pub dir: PathBuf,
    pub source: HomeSource,
}

impl Home {
    /// `{home}/.accounts`.
    pub fn state_dir(&self) -> PathBuf {
        self.dir.join(STATE_DIR)
    }

    pub fn file(&self, name: &str) -> PathBuf {
        self.state_dir().join(name)
    }
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// The base that holds the pointer file: `$SILICON_HOME` or `~`.
pub fn base_home() -> CliResult<(PathBuf, HomeSource)> {
    if let Some(dir) = env_path("SILICON_HOME") {
        return Ok((dir, HomeSource::SiliconHome));
    }
    match std::env::home_dir().filter(|p| !p.as_os_str().is_empty()) {
        Some(dir) => Ok((dir, HomeSource::UserHome)),
        None => Err(CliError::invalid(
            "Could not determine your home directory: HOME is not set.",
            "Set SILICON_HOME or ACCOUNTS_HOME, or pass --home <dir>.",
        )),
    }
}

/// The pointer file for a base.
pub fn pointer_path(base: &Path) -> PathBuf {
    base.join(STATE_DIR).join(POINTER_FILE)
}

/// `Ok` when `dir` is an existing directory, else why it isn't.
pub fn check_dir(dir: &Path) -> Result<(), String> {
    match fs::metadata(dir) {
        Ok(meta) if meta.is_dir() => Ok(()),
        Ok(_) => Err("it is a file".to_owned()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err("it does not exist".to_owned()),
        Err(e) => Err(e.to_string()),
    }
}

/// Fails with `not a directory: <dir>` unless `dir` is an existing directory.
pub fn require_dir(dir: &Path, source: &str) -> CliResult<()> {
    check_dir(dir).map_err(|why| not_a_directory(dir, &why, source))
}

fn not_a_directory(dir: &Path, why: &str, source: &str) -> CliError {
    CliError::new(
        EXIT_INVALID,
        "not_a_directory",
        format!(
            "not a directory: {} ({why}; set by {source})",
            dir.display()
        ),
        "Point it at an existing directory (create it first with mkdir -p), or reset it: `accounts config home --reset` for the configured home, or unset the variable.",
    )
}

/// Resolves the home (see the module docs for the order).
pub fn resolve(flag: Option<&Path>) -> CliResult<Home> {
    if let Some(dir) = flag {
        require_dir(dir, "--home")?;
        return Ok(Home {
            dir: absolute(dir),
            source: HomeSource::Flag,
        });
    }
    if let Some(dir) = env_path("ACCOUNTS_HOME") {
        require_dir(&dir, "ACCOUNTS_HOME")?;
        return Ok(Home {
            dir: absolute(&dir),
            source: HomeSource::AccountsHomeEnv,
        });
    }
    let (base, base_source) = base_home()?;
    let pointer = pointer_path(&base);
    if let Some(configured) = read_pointer(&pointer)? {
        require_dir(
            &configured,
            &format!("`accounts config home`, stored in {}", pointer.display()),
        )?;
        return Ok(Home {
            dir: configured,
            source: HomeSource::Pointer(pointer),
        });
    }
    if base_source == HomeSource::SiliconHome {
        require_dir(&base, "SILICON_HOME")?;
    }
    Ok(Home {
        dir: absolute(&base),
        source: base_source,
    })
}

/// Reads the pointer file (`None` when absent or empty).
pub fn read_pointer(pointer: &Path) -> CliResult<Option<PathBuf>> {
    match fs::read_to_string(pointer) {
        Ok(text) => {
            let line = text.lines().next().unwrap_or("").trim();
            Ok((!line.is_empty()).then(|| PathBuf::from(line)))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) if e.kind() == std::io::ErrorKind::NotADirectory => Ok(None),
        Err(e) => Err(CliError::io("read", pointer, &e)),
    }
}

fn absolute(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Creates a directory (and parents) readable only by this user.
pub fn ensure_private_dir(dir: &Path) -> CliResult<()> {
    if dir.is_dir() {
        return Ok(());
    }
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(dir)
        .map_err(|e| CliError::io("create the directory", dir, &e))
}

/// Writes `bytes` to `path` atomically with mode 0600.
pub fn write_private(path: &Path, bytes: &[u8]) -> CliResult<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    ensure_private_dir(dir)?;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = dir.join(format!(
        ".{name}.tmp-{}-{}",
        std::process::id(),
        silicon_accounts_client::random_token(6)
    ));
    let result = (|| -> std::io::Result<()> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&tmp, path)
    })();
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(CliError::io("write", path, &e));
    }
    Ok(())
}

/// Serializes `value` as pretty JSON into `path` (atomic, 0600).
pub fn write_json<T: Serialize>(path: &Path, value: &T) -> CliResult<()> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|e| {
        CliError::new(
            1,
            "internal",
            format!("Could not encode {} as JSON: {e}.", path.display()),
            "Report this with `accounts report`.",
        )
    })?;
    bytes.push(b'\n');
    write_private(path, &bytes)
}

/// Reads JSON from `path`; `None` when the file does not exist.
pub fn read_json<T: DeserializeOwned>(path: &Path) -> CliResult<Option<T>> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e)
            if matches!(
                e.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) =>
        {
            return Ok(None);
        }
        Err(e) => return Err(CliError::io("read", path, &e)),
    };
    serde_json::from_slice(&bytes).map(Some).map_err(|e| {
        CliError::new(
            1,
            "corrupt_state_file",
            format!("{} is not valid ({e}).", path.display()),
            format!(
                "Delete {} (you may need to sign in again) and retry.",
                path.display()
            ),
        )
    })
}

/// Removes a file; missing files are fine.
pub fn remove_file(path: &Path) -> CliResult<bool> {
    match fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(CliError::io("remove", path, &e)),
    }
}

/// An exclusive lock on `{state}/<name>.lock`, released on drop. Serializes token
/// refreshes across concurrent CLI processes: refresh tokens rotate, and presenting a
/// used one revokes the whole session.
pub struct StateLock {
    _file: fs::File,
}

pub fn lock(state_dir: &Path, name: &str) -> CliResult<StateLock> {
    ensure_private_dir(state_dir)?;
    let path = state_dir.join(format!("{name}.lock"));
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options
        .open(&path)
        .map_err(|e| CliError::io("open the lock file", &path, &e))?;
    file.lock().map_err(|e| CliError::io("lock", &path, &e))?;
    Ok(StateLock { _file: file })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn writes_private_files_atomically() {
        let dir = std::env::temp_dir().join(format!("accounts-home-test-{}", std::process::id()));
        let path = dir.join(".accounts").join("session.json");
        write_json(&path, &serde_json::json!({"a": 1})).unwrap();
        let read: serde_json::Value = read_json(&path).unwrap().unwrap();
        assert_eq!(read["a"], 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(path.parent().unwrap())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }
        assert!(remove_file(&path).unwrap());
        assert!(!remove_file(&path).unwrap());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn require_dir_explains_why() {
        let file = std::env::temp_dir().join(format!("accounts-not-a-dir-{}", std::process::id()));
        fs::write(&file, b"x").unwrap();
        let err = require_dir(&file, "--home").unwrap_err();
        assert!(
            err.message.starts_with("not a directory: "),
            "{}",
            err.message
        );
        assert!(err.message.contains("it is a file"));
        let _ = fs::remove_file(&file);
        let err = require_dir(Path::new("/definitely/missing/dir"), "--home").unwrap_err();
        assert!(err.message.contains("it does not exist"));
    }
}
