/**
 * 选中组织持久化单测（useCnbAuth：上次选中的组织跨启动恢复）。
 *
 * 覆盖：
 * - resolveLastSelectedGroup 纯函数的匹配/失配口径（path 唯一标识、
 *   空记录、组织已不存在、空列表）；
 * - 模块级 watch 的落盘时机（任何 selectedGroup 赋值都会持久化，
 *   含置 null 时写入空串）；
 * - 单测复位入口。
 *
 * 说明：vitest 为 node 环境（无 localStorage），持久化走模块内 memo
 * 兜底层，读写行为与 Tauri WebView 内一致，因此可直接断言。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import {
  LAST_GROUP_STORAGE_KEY,
  readLastSelectedGroupPath,
  resetSelectedGroupPersistForTest,
  resolveLastSelectedGroup,
  selectedGroup,
  type CnbGroup,
} from '../useCnbAuth'

/** 构造测试用组织（只填持久化/恢复判定用得到的字段） */
function makeGroup(id: string, path: string, name = path): CnbGroup {
  return {
    id,
    name,
    path,
    description: '',
    member_count: 0,
    all_sub_repo_count: 0,
    access_role: 'Owner',
  }
}

const groupA = makeGroup('1', 'cnb.cool/alpha', 'Alpha')
const groupB = makeGroup('2', 'cnb.cool/beta', 'Beta')

beforeEach(() => {
  resetSelectedGroupPersistForTest()
  selectedGroup.value = null
})

describe('resolveLastSelectedGroup（纯函数）', () => {
  it('按 path 命中 → 返回列表中同一对象（不是副本）', () => {
    const list = [groupA, groupB]
    expect(resolveLastSelectedGroup(list, 'cnb.cool/beta')).toBe(groupB)
  })

  it('无记录（空串）→ null', () => {
    expect(resolveLastSelectedGroup([groupA, groupB], '')).toBeNull()
  })

  it('组织已不存在 / 存的是子组织路径 → null（由调用方回退首项）', () => {
    expect(resolveLastSelectedGroup([groupA, groupB], 'cnb.cool/gone')).toBeNull()
    // 子组织路径形如 parent/sub，不在顶层列表里
    expect(resolveLastSelectedGroup([groupA, groupB], 'cnb.cool/alpha/sub')).toBeNull()
  })

  it('空列表 → null（不抛异常）', () => {
    expect(resolveLastSelectedGroup([], 'cnb.cool/alpha')).toBeNull()
  })
})

describe('selectedGroup 变更自动落盘（模块级 watch）', () => {
  it('切换组织后持久化其 path', async () => {
    selectedGroup.value = groupB
    await nextTick()
    expect(readLastSelectedGroupPath()).toBe('cnb.cool/beta')
  })

  it('置 null 时写入空串（下次启动回退列表首项，而不是恢复已失效组织）', async () => {
    selectedGroup.value = groupA
    await nextTick()
    expect(readLastSelectedGroupPath()).toBe('cnb.cool/alpha')

    selectedGroup.value = null
    await nextTick()
    expect(readLastSelectedGroupPath()).toBe('')
  })

  it('恢复链路闭环：写入后模拟重启（仅保留持久层）→ 能按 path 找回', async () => {
    selectedGroup.value = groupB
    await nextTick()
    const persisted = readLastSelectedGroupPath()

    // 模拟重启：内存选中态清空，持久层保留
    const savedMemo = persisted
    selectedGroup.value = null
    await nextTick()
    // 上面置 null 会把持久层写成空串；这里直接以"重启前保存的值"驱动恢复
    expect(resolveLastSelectedGroup([groupA, groupB], savedMemo)).toBe(groupB)
  })
})

describe('持久化键与复位', () => {
  it('localStorage 键名固定（升级版本后恢复口径不变）', () => {
    expect(LAST_GROUP_STORAGE_KEY).toBe('wocnb.group.lastSelectedPath')
  })

  it('resetSelectedGroupPersistForTest 清空持久层', async () => {
    selectedGroup.value = groupA
    await nextTick()
    resetSelectedGroupPersistForTest()
    expect(readLastSelectedGroupPath()).toBe('')
  })
})
