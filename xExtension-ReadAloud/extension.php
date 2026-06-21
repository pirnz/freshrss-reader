<?php

declare(strict_types=1);

/**
 * Read Aloud (TTS) extension.
 *
 * Injects a small client-side script + stylesheet on every page. The script
 * adds a read-aloud control to each <article> and drives the browser's
 * Web Speech API (window.speechSynthesis). All logic is client-side; the
 * PHP side only registers the static assets and exposes user config.
 */
final class ReadAloudExtension extends Minz_Extension {
	#[\Override]
	public function init(): void {
		parent::init();

		// Asset URLs are versioned with the file mtime so browsers pick up
		// new releases instead of serving a stale cache.
		Minz_View::appendStyle($this->getFileUrl('main.css', 'css'));

		// Minz_View has no inline-<script> API, so user config is passed to
		// the client by appending query params to the script URL. main.js
		// reads them back from its own <script id="read-aloud-js"> src.
		$ssml = $this->getUserConfigurationValue('ssml', false) ? '1' : '0';
		$langs = $this->normalizeLanguages(
			$this->getUserConfigurationValue('languages', '')
		);
		$url = $this->getFileUrl('main.js', 'js')
			. '&amp;ssml=' . $ssml
			. '&amp;langs=' . urlencode($langs);

		Minz_View::appendScript($url, false, true, true, 'read-aloud-js');
	}

	#[\Override]
	public function handleConfigureAction(): void {
		if (Minz_Request::isPost()) {
			$this->setUserConfiguration([
				'ssml' => Minz_Request::paramBoolean('ssml'),
				'languages' => Minz_Request::paramString('languages'),
			]);
		}
	}

	/**
	 * Collapse the languages textarea (one BCP-47 tag per line, e.g. es-ES)
	 * into a lowercase comma-separated list for the script URL. Blank input
	 * yields '' which the client treats as "show all voices".
	 */
	private function normalizeLanguages(string $raw): string {
		$out = [];
		foreach (preg_split('/\R/', $raw) ?: [] as $line) {
			$tag = strtolower(trim($line));
			if ($tag !== '') {
				$out[] = $tag;
			}
		}
		return implode(',', $out);
	}
}
