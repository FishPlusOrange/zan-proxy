import EventEmitter from 'events';
import fs from 'fs-extra';
import { cloneDeep, forEach, lowerCase } from 'lodash';
import fetch from 'node-fetch';
import path from 'path';
import { Service } from 'typedi';
import uuid from 'uuid/v4';

import { Rule, RuleAction, RuleActionData, RuleFile } from '@core/types/rule';

import { AppInfoService } from './appInfo';

export const ErrNameExists = new Error('name exists');

@Service()
export class RuleService extends EventEmitter {
  public rules: { [user: string]: { [name: string]: RuleFile } };
  private usingRuleCache: object;
  private ruleSaveDir: string;
  constructor(appInfoService: AppInfoService) {
    super();
    // userId - > (filename -> rule)
    this.rules = {};
    // 缓存数据: 正在使用的规则 userId -> inUsingRuleList
    this.usingRuleCache = {};
    const proxyDataDir = appInfoService.proxyDataDir;
    this.ruleSaveDir = path.join(proxyDataDir, 'rule');

    const contentMap = fs
      .readdirSync(this.ruleSaveDir)
      .filter(name => name.endsWith('.json'))
      .reduce((prev, curr) => {
        try {
          prev[curr] = fs.readJsonSync(path.join(this.ruleSaveDir, curr));
        } catch (e) {
          // ignore
        }
        return prev;
      }, {});
    forEach(contentMap, (content, fileName) => {
      // @ts-ignore
      const ruleName = content.name;
      const userId = fileName.substr(0, this._getUserIdLength(fileName, ruleName));
      this.rules[userId] = this.rules[userId] || {};
      this.rules[userId][ruleName] = content;
    });
  }

  // 创建规则文件
  public async createRuleFile(userId, name, description) {
    if (this.rules[userId] && this.rules[userId][name]) {
      return ErrNameExists;
    }
    const ruleFile = {
      checked: false,
      content: [],
      description,
      meta: {
        ETag: '',
        remote: false,
        remoteETag: '',
        url: '',
      },
      name,
    };
    this.rules[userId] = this.rules[userId] || {};
    this.rules[userId][name] = ruleFile;
    // 写文件
    const filePath = this._getRuleFilePath(userId, name);
    await fs.writeJson(filePath, ruleFile, { encoding: 'utf-8' });
    // 发送消息通知
    this.emit('data-change', userId, this.getRuleFileList(userId));
    return true;
  }

  // 返回用户的规则文件列表
  public getRuleFileList(userId: string) {
    return Object.values(this.rules[userId] || {});
  }

  // 删除规则文件
  public async deleteRuleFile(userId, name) {
    const rule = this.rules[userId][name];

    delete this.rules[userId][name];

    const ruleFilePath = this._getRuleFilePath(userId, name);
    await fs.remove(ruleFilePath);
    // 发送消息通知
    this.emit('data-change', userId, this.getRuleFileList(userId));
    if (rule.checked) {
      // 清空缓存
      delete this.usingRuleCache[userId];
    }
  }

  // 设置规则文件的使用状态
  public async setRuleFileCheckStatus(userId, name, checked) {
    this.rules[userId][name].checked = checked;
    const ruleFilePath = this._getRuleFilePath(userId, name);
    await fs.writeJson(ruleFilePath, this.rules[userId][name], {
      encoding: 'utf-8',
    });
    // 发送消息通知
    this.emit('data-change', userId, this.getRuleFileList(userId));
    delete this.usingRuleCache[userId];
  }

  // 获取规则文件的内容
  public getRuleFile(userId, name) {
    return this.rules[userId][name];
  }

  // 保存规则文件(可能是远程、或者本地)
  public async saveRuleFile(userId, ruleFile: RuleFile) {
    const userRuleMap = this.rules[userId] || {};
    const originRuleFile = userRuleMap[ruleFile.name];
    if (originRuleFile) {
      ruleFile.checked = originRuleFile.checked;
      ruleFile.meta = originRuleFile.meta;
    }
    userRuleMap[ruleFile.name] = ruleFile;
    this.rules[userId] = userRuleMap;
    // 写文件
    const filePath = this._getRuleFilePath(userId, ruleFile.name);
    await fs.writeJson(filePath, userRuleMap[ruleFile.name], {
      encoding: 'utf-8',
    });
    // 清空缓存
    delete this.usingRuleCache[userId];
    this.emit('data-change', userId, this.getRuleFileList(userId));
  }

  // 修改规则文件名称
  public async updateFileInfo(
    userId,
    originName: string,
    {
      name,
      description,
    }: {
      name: string;
      description: string;
    },
  ) {
    const userRuleMap = this.rules[userId] || {};
    if (userRuleMap[name] && name !== originName) {
      throw ErrNameExists;
    }
    const ruleFile = userRuleMap[originName];
    // 删除旧的rule
    delete this.rules[userId][originName];
    const ruleFilePath = this._getRuleFilePath(userId, originName);
    await fs.remove(ruleFilePath);

    // 修改rule名称
    ruleFile.name = name;
    ruleFile.description = description;
    await this.saveRuleFile(userId, ruleFile);
  }

  /**
   * 根据请求,获取处理请求的规则
   * @param method
   * @param urlObj
   */
  public getProcessRule(userId, method, urlObj): Rule | null {
    let candidateRule = null;
    const inusingRules = this.getUsingRules(userId);
    for (const rule of inusingRules) {
      // 捕获规则
      if (this._isUrlMatch(urlObj.href, rule.match) && this._isMethodMatch(method, rule.method)) {
        candidateRule = rule;
        break;
      }
    }
    return candidateRule;
  }

  public async importRemoteRuleFile(userId, url): Promise<RuleFile> {
    const ruleFile = await this.fetchRemoteRuleFile(url);
    ruleFile.content.forEach(rule => {
      if (rule.action && !rule.actionList) {
        rule.actionList = [rule.action];
      }
    });
    await this.saveRuleFile(userId, ruleFile);
    return ruleFile;
  }

  public async fetchRemoteRuleFile(url): Promise<any> {
    const response = await fetch(url);
    const responseData = await response.json();
    const ETag = response.headers.get('etag') || '';
    const content = responseData.content.map(remoteRule => {
      if (remoteRule.action && !remoteRule.actionList) {
        remoteRule.actionList = [remoteRule.action];
      }
      const actionList = remoteRule.actionList.map(remoteAction => {
        const actionData: RuleActionData = {
          dataId: '',
          headerKey: remoteAction.data.headerKey || '',
          headerValue: remoteAction.data.headerValue || '',
          target: remoteAction.data.target || '',
        };
        const action: RuleAction = {
          data: actionData,
          type: remoteAction.type,
        };
        return action;
      });
      const rule: Rule = {
        actionList,
        checked: remoteRule.checked,
        key: remoteRule.key || uuid(),
        match: remoteRule.match,
        method: remoteRule.method,
        name: remoteRule.name,
      };
      return rule;
    });
    const ruleFile = {
      checked: false,
      content,
      description: responseData.description,
      meta: {
        ETag,
        remote: true,
        remoteETag: ETag,
        url,
      },
      name: responseData.name,
    };
    return ruleFile;
  }

  public async copyRuleFile(userId, name) {
    const ruleFile = this.getRuleFile(userId, name);
    if (!ruleFile) {
      return;
    }
    const copied = cloneDeep(ruleFile);
    copied.checked = false;
    copied.name = `${copied.name}-复制`;
    copied.meta = Object.assign({}, copied.meta, {
      isCopy: true,
      remote: false,
    });
    await this.saveRuleFile(userId, copied);
    return copied;
  }

  private getUsingRules(userId) {
    if (this.usingRuleCache[userId]) {
      return this.usingRuleCache[userId];
    }
    const ruleMap = this.rules[userId] || {};
    // 计算使用中的规则
    const rulesLocal: Rule[] = [];
    const rulesRemote: Rule[] = [];
    forEach(ruleMap, (file, filename) => {
      // 转发规则未被选中
      if (!file.checked) {
        return;
      }
      forEach(file.content, rule => {
        if (!rule.checked) {
          return;
        }
        const copy = cloneDeep(rule);
        if (file.meta && file.meta.remote) {
          rulesRemote.push(copy);
        } else {
          rulesLocal.push(copy);
        }
      });
    });
    const merged = rulesLocal.concat(rulesRemote);
    this.usingRuleCache[userId] = merged;
    return merged;
  }

  private _getRuleFilePath(userId, ruleName) {
    const fileName = `${userId}_${ruleName}.json`;
    const filePath = path.join(this.ruleSaveDir, fileName);
    return filePath;
  }

  private _getUserIdLength(ruleFileName, ruleName) {
    return ruleFileName.length - ruleName.length - 6;
  }

  // 请求的方法是否匹配规则
  private _isMethodMatch(reqMethod, ruleMethod) {
    const loweredReqMethod = lowerCase(reqMethod);
    const loweredRuleMethod = lowerCase(ruleMethod);
    return loweredReqMethod === loweredRuleMethod || !ruleMethod || loweredReqMethod === 'option';
  }

  // 请求的url是否匹配规则
  private _isUrlMatch(reqUrl, ruleMatchStr) {
    return (
      ruleMatchStr && (reqUrl.indexOf(ruleMatchStr) >= 0 || new RegExp(ruleMatchStr).test(reqUrl))
    );
  }
}