import { USER_ID } from '../data/schema';

/**
 * 记忆的归属是谁。
 *
 * 一句话：**关于一个人的记忆只存一份**，挂在「这个人」名下；线级的挂在线上；
 * 执行体自己的习惯挂在执行体上。三类各自成域，靠 `owner_id` 区分。
 *
 * 之前的实参是 `task.assigneeId`——也就是**执行体实例**。于是用户说的一句
 * 「以后结论放前面」被切成了 N+1 份：Router 一份、每个执行体各一份，谁也不知道谁
 * 记了什么。这不是实现细节，是把「关于这个人」和「关于这个 agent」混成了一个词。
 *
 * 现在只有三个归属：
 *
 * ```
 * USER_MEMORY_OWNER ('user')   关于这个人：偏好、称呼、格式禁令  ← Router 写，所有人读
 * thread.id                    关于这条线：这单的约定、踩过的坑  ← 谁干谁写，换人还在
 * worker.id                    关于这个执行体怎么干活（自己的习惯）
 * ```
 *
 * 执行体**只读**前两个域，不能写。一个执行体的错误推论不该污染全局认知。
 */
export const USER_MEMORY_OWNER: string = USER_ID;

/**
 * 一次召回要跨哪些归属。
 *
 * 这三个域是**并列**的，不是层级：人是人，线是线，执行体是执行体。所以召回总是跨域，
 * 而不是先查人、查不到再查线——那条线的经验不该因为"人的偏好里有一条更相关"就被挤掉。
 *
 * 去重是必要的：一条没有线的工作，`threadId` 与 `workerId` 同源时不该查两遍。
 */
export function recallOwners(input: {
  threadId?: string | null;
  workerId?: string | null;
}): string[] {
  const owners = [USER_MEMORY_OWNER];
  for (const owner of [input.threadId, input.workerId]) {
    if (owner && !owners.includes(owner)) owners.push(owner);
  }
  return owners;
}
