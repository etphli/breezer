import assert from 'node:assert/strict';
import test from 'node:test';
import { detectBrowserTask } from '../../features/ai/extension/browser-task-intent.js';

test('recognizes requests to count or list open tabs', () => {
  for (const prompt of [
    'How many tabs do I have open?',
    'Could you please count my open tabs across all windows?',
    'List all the open tabs in this window.',
    'Show me my tabs',
    'What tabs do I have open right now?',
    'Which tabs are currently open?',
    'What’s my current tab count?',
    'How many tabs are open, and how much memory are they using?',
  ]) {
    assert.equal(detectBrowserTask(prompt), 'stats', prompt);
  }
});

test('recognizes current browser, tab and device memory requests', () => {
  for (const prompt of [
    'How much RAM is Breezer using?',
    'How much memory is this tab using?',
    'How much memory are my tabs using?',
    'Which tabs are using the most memory?',
    'What is eating memory?',
    'What is using most of my RAM?',
    'What’s using up all my RAM right now?',
    'Show me how much memory Breezer is using',
    'How much RAM do I have left?',
    'How much memory is available on my Mac?',
    'How much of my RAM is being used?',
    'What is my total RAM?',
    'Check available RAM, please.',
    'Show me my browser memory usage',
    'Show me memory usage by tab.',
  ]) {
    assert.equal(detectBrowserTask(prompt), 'stats', prompt);
  }
});

test('recognizes requests to design a browser theme or background', () => {
  for (const prompt of [
    'Make a theme',
    'Draw a theme',
    'Make me a dark theme.',
    'Make me a charcoal theme with purple accents',
    'Give me a dark forest theme',
    'Could you design a forest green theme for my browser?',
    'Change my browser theme to navy.',
    'Give my browser a dark theme.',
    'Set Breezer’s background color to lavender.',
    'Change the new tab background to an autumn forest.',
  ]) {
    assert.equal(detectBrowserTask(prompt), 'theme', prompt);
  }
});

test('recognizes image-based theme shorthand with an image attached', () => {
  for (const prompt of [
    'Make a color scheme from this image',
    'Use this as my background',
    'Theme from this',
    'Use this image as my New Tab background and make a theme from it.',
    'Turn the attached photo into a browser theme.',
  ]) {
    assert.equal(detectBrowserTask(prompt, { hasImage: true }), 'theme', prompt);
    assert.equal(detectBrowserTask(prompt), '', prompt);
  }
});

test('recognizes direct revisions after a theme proposal', () => {
  for (const prompt of [
    'Make it a little darker.',
    'Could you make it slightly brighter?',
    'Change the background to blue',
    'Set the theme colour to a deeper purple.',
  ]) {
    assert.equal(detectBrowserTask(prompt, { hasTheme: true }), 'theme', prompt);
    assert.equal(detectBrowserTask(prompt), '', prompt);
  }
  for (const prompt of [
    'What does this color mean?',
    'Make it faster.',
    'Change the background to blue in my React app.',
  ]) {
    assert.equal(detectBrowserTask(prompt, { hasTheme: true }), '', prompt);
  }
});

test('keeps navigation, research and coding requests in ordinary chat', () => {
  for (const prompt of [
    'Open a new tab',
    'Show me the GitHub tab',
    'Switch to my last tab',
    'List my open tabs and close any duplicates.',
    'How many tabs can a browser handle?',
    'What tabs do I have to open to reproduce this?',
    'Explain how browsers count open tabs.',
    'What is RAM?',
    'How much RAM do I need to run Chrome?',
    'Which tabs are using the most memory in Chrome on average?',
    'Why do browsers use so much RAM?',
    'Make a dark theme for my React app.',
    'Design a theme for my photography website.',
    'Make a browser theme for my app.',
    'Make a dark React theme.',
    'Make me a charcoal theme with purple accents for my website.',
    'Make a browser theme with colors for my website.',
    'Make a tutorial on browser themes.',
    'Make a tutorial on browser theme.',
    'Make a color scheme from this image for my site.',
    'What colors are in this image?',
    'Use this as my profile photo.',
    'Make a theme\n```css\nbody { background: navy; }\n```',
    'const prompt = "How many tabs are open?";',
    'How many tabs?\nconst tabs = await chrome.tabs.query({});',
    '',
  ]) {
    assert.equal(detectBrowserTask(prompt, { hasImage: true }), '', prompt);
  }
});

test('recognizes conversational requests about this browser', () => {
  for (const prompt of [
    'Show me a list of my open tabs',
    'What browser tabs are open and which one uses the most RAM?',
    'How much RAM is my browser using on Windows?',
    'How much RAM is being used by the browser?',
    'How much RAM is Breezer using compared to my computer?',
    'Which of my tabs is taking up the most memory?',
    'How many tabs have I got open?',
    'Can you show me what tabs I have open?',
  ]) assert.equal(detectBrowserTask(prompt), 'stats', prompt);

  for (const prompt of [
    'Make my browser dark purple',
    'I’d like a Breezer theme with an animated night sky.',
    'Make me a really dark blue and purple theme',
    'Create a theme that looks like a forest at night',
    'Set my New Tab wallpaper to a rainy forest.',
    'Give Breezer a purple theme with animated stars.',
  ]) assert.equal(detectBrowserTask(prompt), 'theme', prompt);
});

test('routes browser commands typed into chat without opening Browser tools', () => {
  assert.equal(detectBrowserTask('Check how much RAM Breezer is using.'), 'stats');
  assert.equal(detectBrowserTask('Use your browser tools to show my browser stats.'), 'stats');
  assert.equal(detectBrowserTask('Run browser_stats'), 'stats');
  assert.equal(detectBrowserTask('Make my browser look like a foggy forest.'), 'theme');
  assert.equal(detectBrowserTask('Bring back my previous look.'), 'restore');
  assert.equal(detectBrowserTask('Undo the browser theme change.'), 'restore');
  assert.equal(detectBrowserTask('Explain how to restore the previous theme in my project.'), '');
});
