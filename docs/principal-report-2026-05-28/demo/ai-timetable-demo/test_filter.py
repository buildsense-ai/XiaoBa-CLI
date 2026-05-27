from app.data import normalized_class_counts, apply_school_scope, build_classes

counts = normalized_class_counts({'七年级': 6, '八年级': 6, '九年级': 6})
print('After normalized:', counts)

filtered = apply_school_scope(counts, '初中')
print('After filter:', filtered)

classes = build_classes(filtered)
print('Classes count:', len(classes))
print('First 3:', classes[:3])
