import {
    IAction,
    addHiddenProp,
    boundActionDecorator,
    createAction,
    executeAction,
    fail,
    invariant,
    namedActionDecorator
} from "../internal"

export interface IActionFactory {
    // nameless actions
    <T extends Function | null | undefined>(fn: T): T & IAction
    // named actions
    <T extends Function | null | undefined>(name: string, fn: T): T & IAction

    // named decorator
    (customName: string): (
        target: Object,
        key: string | symbol,
        baseDescriptor?: PropertyDescriptor
    ) => void

    // unnamed decorator
    (target: Object, propertyKey: string | symbol, descriptor?: PropertyDescriptor): void

    // @action.bound decorator
    bound(target: Object, propertyKey: string | symbol, descriptor?: PropertyDescriptor): void
}

/**
 * 接收一个函数并返回具有同样签名的函数，但是用 transaction、untracked 和 allowStateChanges 包裹起来，
 * 尤其是 transaction 的自动应用会产生巨大的性能收益， 
 * 动作会分批处理变化并只在(最外层的)动作完成后通知计算值和反应。 
 * 这将确保在动作完成之前，在动作期间生成的中间值或未完成的值对应用的其余部分是不可见的。
 */
export const action: IActionFactory = function action(arg1, arg2?, arg3?, arg4?): any {
    // action(fn() {})
    if (arguments.length === 1 && typeof arg1 === "function")
        return createAction(arg1.name || "<unnamed action>", arg1)
    // action("name", fn() {})
    if (arguments.length === 2 && typeof arg2 === "function") return createAction(arg1, arg2)

    // @action("name") fn() {}
    if (arguments.length === 1 && typeof arg1 === "string") return namedActionDecorator(arg1)

    // @action fn() {}
    if (arg4 === true) {
        // apply to instance immediately
        addHiddenProp(arg1, arg2, createAction(arg1.name || arg2, arg3.value, this))
    } else {
        return namedActionDecorator(arg2).apply(null, arguments as any)
    }
} as any

action.bound = boundActionDecorator as any

export function runInAction<T>(block: () => T): T
export function runInAction<T>(name: string, block: () => T): T
export function runInAction(arg1, arg2?) {
    const actionName = typeof arg1 === "string" ? arg1 : arg1.name || "<unnamed action>"
    const fn = typeof arg1 === "function" ? arg1 : arg2

    if (process.env.NODE_ENV !== "production") {
        invariant(
            typeof fn === "function" && fn.length === 0,
            "`runInAction` expects a function without arguments"
        )
        if (typeof actionName !== "string" || !actionName)
            fail(`actions should have valid names, got: '${actionName}'`)
    }

    return executeAction(actionName, fn, this, undefined)
}

export function isAction(thing: any) {
    return typeof thing === "function" && thing.isMobxAction === true
}

export function defineBoundAction(target: any, propertyName: string, fn: Function) {
    addHiddenProp(target, propertyName, createAction(propertyName, fn.bind(target)))
}
