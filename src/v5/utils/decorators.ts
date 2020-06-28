import { EMPTY_ARRAY, addHiddenProp, fail } from "../internal"

export const mobxDidRunLazyInitializersSymbol = Symbol("mobx did run lazy initializers")
export const mobxPendingDecorators = Symbol("mobx pending decorators")

type DecoratorTarget = {
    [mobxDidRunLazyInitializersSymbol]?: boolean
    [mobxPendingDecorators]?: { [prop: string]: DecoratorInvocationDescription }
}

/**
 * interface PropertyDescriptor {
    configurable?: boolean;
    enumerable?: boolean;
    value?: any;
    writable?: boolean;
    get?(): any;
    set?(v: any): void;
}
 */
export type BabelDescriptor = PropertyDescriptor & { initializer?: () => any }

export type PropertyCreator = (
    instance: any,
    propertyName: PropertyKey,
    descriptor: BabelDescriptor | undefined,
    decoratorTarget: any,
    decoratorArgs: any[]
) => void

type DecoratorInvocationDescription = {
    prop: string
    propertyCreator: PropertyCreator
    descriptor: BabelDescriptor | undefined
    decoratorTarget: any
    decoratorArguments: any[]
}

const enumerableDescriptorCache: { [prop: string]: PropertyDescriptor } = {}
const nonEnumerableDescriptorCache: { [prop: string]: PropertyDescriptor } = {}

function createPropertyInitializerDescriptor(
    prop: string,
    enumerable: boolean
): PropertyDescriptor {
    const cache = enumerable ? enumerableDescriptorCache : nonEnumerableDescriptorCache
    return (
        cache[prop] ||
        (cache[prop] = {
            configurable: true,
            enumerable: enumerable,
            get() {
                initializeInstance(this)
                return this[prop]
            },
            set(value) {
                initializeInstance(this)
                this[prop] = value
            }
        })
    )
}

export function initializeInstance(target: any)
export function initializeInstance(target: DecoratorTarget) {
    if (target[mobxDidRunLazyInitializersSymbol] === true) return
    /** target[mobxPendingDecorators]![prop] = {
                prop,
                propertyCreator,
                descriptor,
                decoratorTarget: target,
                decoratorArguments
            }
    */
    const decorators = target[mobxPendingDecorators]
    if (decorators) {
        addHiddenProp(target, mobxDidRunLazyInitializersSymbol, true)
        // Build property key array from both strings and symbols
        const keys = [...Object.getOwnPropertySymbols(decorators), ...Object.keys(decorators)]
        for (const key of keys) {
            const d = decorators[key as any]
            d.propertyCreator(target, d.prop, d.descriptor, d.decoratorTarget, d.decoratorArguments)
        }
    }
}

export function createPropDecorator(
    propertyInitiallyEnumerable: boolean,
    propertyCreator: PropertyCreator
) {
    return function decoratorFactory() {
        let decoratorArguments: any[]

        const decorator = function decorate(
            target: DecoratorTarget,
            prop: string,
            descriptor: BabelDescriptor | undefined,
            applyImmediately?: any
            // This is a special parameter to signal the direct application of a decorator, allow extendObservable to skip the entire type decoration part,
            // as the instance to apply the decorator to equals the target
        ) {
            if (applyImmediately === true) {
                propertyCreator(target, prop, descriptor, target, decoratorArguments)
                return null
            }
            if (process.env.NODE_ENV !== "production" && !quacksLikeADecorator(arguments))
                fail("This function is a decorator, but it wasn't invoked like a decorator")
            if (!Object.prototype.hasOwnProperty.call(target, mobxPendingDecorators)) {
                // mobxPendingDecorators = Symbol("mobx pending decorators")
                const inheritedDecorators = target[mobxPendingDecorators]
                addHiddenProp(target, mobxPendingDecorators, { ...inheritedDecorators })
            }
            /**
             * createPropDecorator 传进来的第二个参数，
             * 然后放进了 target[mobxPendingDecorators]![prop] 属性中，
             * 供 extendObservable 使用
             */
            target[mobxPendingDecorators]![prop] = {
                prop,
                propertyCreator,
                descriptor,
                decoratorTarget: target,
                decoratorArguments
            }
            return createPropertyInitializerDescriptor(prop, propertyInitiallyEnumerable)
        }

        if (quacksLikeADecorator(arguments)) {
            // @decorator 无参数
            decoratorArguments = EMPTY_ARRAY
            // 无参时，返回描述符descriptor（decorator.apply(null, arguments)执行的结果返回描述符）
            return decorator.apply(null, arguments as any)
        } else {
            // @decorator(args) 有参数
            // decoratorArguments在此处赋值，在 decorator 函数中使用（利用闭包）
            decoratorArguments = Array.prototype.slice.call(arguments)
            return decorator
        }
    } as Function
}

/**
 * quacksLikeADecorator 判断装饰器为哪种类型：无参返回true
 * 
 * （1）当装饰器无参时：
 *  args:
 *      target: DecoratorTarget,
        prop: string,
        descriptor: BabelDescriptor | undefined,
        applyImmediately?: any
 * （2）当装饰器有参时
    args: 为装饰器带有的参数，多个参数的话是个数组对象（如@deepDecorator("deep") b = 2）
 */
export function quacksLikeADecorator(args: IArguments): boolean {
    return (
        ((args.length === 2 || args.length === 3) &&
            (typeof args[1] === "string" || typeof args[1] === "symbol")) ||
        (args.length === 4 && args[3] === true)
    )
}
