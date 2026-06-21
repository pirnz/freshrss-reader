<?php

declare(strict_types=1);

/**
 * Read Aloud (TTS) extension.
 *
 * Injects a small client-side script + stylesheet on every page. The script
 * adds a read-aloud control to each <article> and drives the browser's
 * Web Speech API (window.speechSynthesis). All logic is client-side; the
 * PHP side only registers the static assets.
 */
final class ReadAloudExtension extends Minz_Extension {
	#[\Override]
	public function init(): void {
		parent::init();

		// Asset URLs are versioned with the extension version so browsers
		// pick up new releases instead of serving a stale cache.
		Minz_View::appendStyle($this->getFileUrl('main.css', 'css'));
		Minz_View::appendScript($this->getFileUrl('main.js', 'js'));
	}
}
