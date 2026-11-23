/**
 * Copyright 2021-present, Facebook, Inc. All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

"use strict";

module.exports = class Message {
  constructor(rawMessage) {
    this.id = rawMessage.id;
    this.timestamp = rawMessage.timestamp ?? null;
    this.textBody =
      rawMessage.type === 'text' && typeof rawMessage.text?.body === 'string'
        ? rawMessage.text.body
        : null;

    let type = rawMessage.type;
    if (type === 'interactive') {
      if (rawMessage.interactive?.type === 'button_reply') {
        this.type = 'interactive_button';
        this.interactiveId = rawMessage.interactive.button_reply.id;
        this.textBody = rawMessage.interactive.button_reply.title;
      } else if (rawMessage.interactive?.type === 'list_reply') {
        this.type = 'interactive_list';
        this.interactiveId = rawMessage.interactive.list_reply.id;
        this.textBody = rawMessage.interactive.list_reply.title;
      } else {
        this.type = 'interactive';
      }
    } else {
      this.type = type;
    }

    this.senderPhoneNumber = rawMessage.from;
  }
};
