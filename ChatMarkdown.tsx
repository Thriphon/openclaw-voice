import React from 'react';
import { Platform, StyleSheet } from 'react-native';
import Markdown from 'react-native-markdown-display';

type ChatMarkdownProps = {
  content: string;
};

const TEXT_COLOR = '#e0e0e0';
const HEADING_COLOR = '#fff';
const CODE_BACKGROUND = '#1a1a2e';
const LINK_COLOR = '#9fa8da';

const BASE_FONT = {
  fontSize: 16,
  lineHeight: 22,
};

const markdownStyles = StyleSheet.create({
  body: {
    ...BASE_FONT,
    color: TEXT_COLOR,
    margin: 0,
  },
  paragraph: {
    marginTop: 0,
    marginBottom: 8,
  },
  strong: {
    fontWeight: '700',
    color: HEADING_COLOR,
  },
  em: {
    fontStyle: 'italic',
  },
  link: {
    color: LINK_COLOR,
    textDecorationLine: 'underline',
  },
  bullet_list: {
    marginBottom: 6,
  },
  ordered_list: {
    marginBottom: 6,
  },
  list_item: {
    marginBottom: 4,
  },
  bullet_list_icon: {
    color: TEXT_COLOR,
  },
  ordered_list_icon: {
    color: TEXT_COLOR,
  },
  heading1: {
    ...BASE_FONT,
    color: HEADING_COLOR,
    fontWeight: '700',
    fontSize: 20,
    marginBottom: 8,
  },
  heading2: {
    ...BASE_FONT,
    color: HEADING_COLOR,
    fontWeight: '700',
    fontSize: 18,
    marginBottom: 6,
  },
  heading3: {
    ...BASE_FONT,
    color: HEADING_COLOR,
    fontWeight: '700',
    fontSize: 16,
    marginBottom: 6,
  },
  code_inline: {
    backgroundColor: CODE_BACKGROUND,
    color: '#f0f0f0',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 14,
    borderRadius: 4,
    paddingHorizontal: 4,
  },
  fence: {
    backgroundColor: CODE_BACKGROUND,
    color: '#f0f0f0',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 14,
    borderRadius: 8,
    padding: 10,
    marginVertical: 6,
  },
  code_block: {
    backgroundColor: CODE_BACKGROUND,
    color: '#f0f0f0',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 14,
    borderRadius: 8,
    padding: 10,
    marginVertical: 6,
  },
  blockquote: {
    backgroundColor: '#1a1a2e',
    borderLeftColor: '#5c6bc0',
    borderLeftWidth: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginVertical: 4,
  },
  hr: {
    backgroundColor: '#4a4a6a',
    height: 1,
    marginVertical: 8,
  },
});

export default function ChatMarkdown({ content }: ChatMarkdownProps) {
  return <Markdown style={markdownStyles}>{content}</Markdown>;
}
